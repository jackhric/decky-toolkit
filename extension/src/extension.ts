import * as vscode from 'vscode';
import { DeckyClient, HttpError, describeError, isMissingRoute, sleep } from './client';
import { Connection } from './connection';
import { deploy, findPluginFolders, pluginDirName } from './deploy';
import { LogManager } from './logs';
import { ScreenPanel, StatusBar } from './screenPanel';

const PAIR_TIMEOUT_MS = 120_000;
const PAIR_POLL_MS = 2000;

let conn: Connection | undefined;

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  conn = new Connection(ctx);
  const c = conn;
  await c.refresh();
  const status = new StatusBar(c);
  const logs = new LogManager(c);
  const deployOut = vscode.window.createOutputChannel('Decky-MCP Deploy');
  const consoleOut = vscode.window.createOutputChannel('Decky-MCP Console');
  ctx.subscriptions.push(c, status, logs, deployOut, consoleOut);

  const command = (id: string, fn: () => Promise<unknown>) =>
    ctx.subscriptions.push(vscode.commands.registerCommand(id, async () => {
      try {
        await fn();
      } catch (e) {
        void vscode.window.showErrorMessage(`Decky-MCP: ${describeError(e)}`);
      }
    }));

  command('decky-mcp.pair', () => pair(c));
  command('decky-mcp.enterToken', () => enterToken(c));
  command('decky-mcp.disconnect', async () => {
    await c.clearToken();
    void vscode.window.showInformationMessage(`Decky-MCP: forgot the token for ${c.label}.`);
  });
  command('decky-mcp.openScreen', async () => {
    if (await c.client()) await ScreenPanel.show(ctx, c, status);
  });
  command('decky-mcp.deploy', async () => {
    const client = await c.client();
    if (client) await deploy(client, deployOut);
  });
  command('decky-mcp.restartLoader', async () => {
    const client = await c.client();
    if (!client) return;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Restarting Decky Loader' }, async progress => {
      await client.restartLoader();
      progress.report({ message: 'waiting for it to come back…' });
      const h = await client.waitForRestart();
      void vscode.window.showInformationMessage(`Decky-MCP: loader restarted (${h.name} ${h.version}).`);
    });
  });
  command('decky-mcp.reloadPlugin', async () => {
    const client = await c.client();
    const dir = client && await pickDeviceDir(client, 'Plugin to reload');
    if (!client || !dir) return;
    try {
      await client.reloadPlugin(dir);
    } catch (e) {
      if (isMissingRoute(e)) {
        throw new Error('the Decky-MCP plugin on the device has no POST /plugins/{dir}/reload yet; update it, or use "Decky: Restart loader".');
      }
      throw e;
    }
    void vscode.window.showInformationMessage(`Decky-MCP: reloaded ${dir}.`);
  });
  command('decky-mcp.loaderLogs', async () => {
    if (await c.client()) logs.show('loader', 'Decky Loader', { source: 'loader' });
  });
  command('decky-mcp.pluginLogs', async () => {
    const client = await c.client();
    const dir = client && await pickDeviceDir(client, 'Show logs of which plugin?');
    if (dir) logs.show(`plugin:${dir}`, `Decky: ${dir}`, { source: 'plugin', plugin: dir });
  });
  command('decky-mcp.evaluate', () => evaluate(c, consoleOut, ctx));
  command('decky-mcp.toast', async () => {
    const client = await c.client();
    if (!client) return;
    const body = await vscode.window.showInputBox({ prompt: 'Toast text to show on the Deck', value: 'Hello from VS Code' });
    if (!body) return;
    await client.callToolText('toast', { title: 'VS Code', body });
  });
  command('decky-mcp.writeMcpConfig', () => writeMcpConfig(c));
}

export function deactivate(): void {
  conn?.dispose();
  conn = undefined;
}

async function pair(c: Connection): Promise<void> {
  const client = c.unauthenticatedClient();
  try {
    await client.health();
  } catch (e) {
    throw new Error(`cannot reach ${client.baseUrl} (${describeError(e)}). Check decky-mcp.host / decky-mcp.port.`);
  }
  const offerManual = async (why: string) => {
    const choice = await vscode.window.showWarningMessage(`Decky-MCP: ${why}`, 'Enter token manually');
    if (choice) await enterToken(c);
  };

  const grant = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Pairing with ${c.label}: press "Pair a browser" in the Decky-MCP panel on the Deck`,
      cancellable: true,
    },
    async (progress, token) => {
      const start = Date.now();
      while (!token.isCancellationRequested && Date.now() - start < PAIR_TIMEOUT_MS) {
        const left = Math.ceil((PAIR_TIMEOUT_MS - (Date.now() - start)) / 1000);
        progress.report({ message: `waiting… ${left} s` });
        try {
          const r = await client.pair();
          if (r === 'unsupported') return 'unsupported' as const;
          if (r !== 'closed') return r;
        } catch {
          // transient (loader restarting); keep polling
        }
        await sleep(PAIR_POLL_MS);
      }
      return token.isCancellationRequested ? 'cancelled' as const : 'timeout' as const;
    });

  if (grant === 'cancelled') return;
  if (grant === 'unsupported') {
    return offerManual('this device has no /pair route yet (older Decky-MCP). Copy the token from the Decky-MCP panel instead.');
  }
  if (grant === 'timeout') return offerManual('no pairing window was opened within 120 s.');
  await c.setToken(grant.token);
  await announce(c, 'Paired');
}

async function enterToken(c: Connection): Promise<void> {
  const token = (await vscode.window.showInputBox({
    prompt: `Bearer token for ${c.label} (shown in the Decky-MCP Quick Access panel)`,
    password: true,
    ignoreFocusOut: true,
    validateInput: v => (v.trim() ? undefined : 'Token is empty'),
  }))?.trim();
  if (!token) return;
  try {
    await new DeckyClient(c.address, token).listTools();
  } catch (e) {
    if (e instanceof HttpError && e.status === 401) throw new Error('the device rejected that token.');
    void vscode.window.showWarningMessage(`Decky-MCP: could not verify the token (${describeError(e)}); saved it anyway.`);
  }
  await c.setToken(token);
  await announce(c, 'Connected to');
}

async function announce(c: Connection, verb: string): Promise<void> {
  try {
    const h = await c.unauthenticatedClient().health();
    void vscode.window.showInformationMessage(`Decky-MCP: ${verb} ${c.label}: ${h.name} ${h.version}, API v${h.api_version}, ${h.tools} tools.`);
  } catch (e) {
    void vscode.window.showWarningMessage(`Decky-MCP: token saved, but /health failed: ${describeError(e)}`);
  }
}

async function pickDeviceDir(client: DeckyClient, placeHolder: string): Promise<string | undefined> {
  const local = (await findPluginFolders()).map(pluginDirName);
  let remote: string[] = [];
  try {
    remote = (await client.listPlugins()).map(p => p.dir);
  } catch {
    // offline: still allow picking the workspace plugin
  }
  const dirs = [...new Set([...local, ...remote])];
  if (dirs.length === 0) return vscode.window.showInputBox({ prompt: 'Plugin directory name under ~/homebrew/plugins' });
  const items = dirs.map(d => ({ label: d, description: local.includes(d) ? 'workspace' : undefined }));
  return (await vscode.window.showQuickPick(items, { placeHolder }))?.label;
}

async function evaluate(c: Connection, out: vscode.OutputChannel, ctx: vscode.ExtensionContext): Promise<void> {
  const client = await c.client();
  if (!client) return;
  const expression = await vscode.window.showInputBox({
    prompt: 'JavaScript to evaluate in Steam SharedJSContext (promises are awaited)',
    value: ctx.workspaceState.get<string>('decky-mcp.lastExpression', 'window.DeckyPluginLoader?.version'),
    ignoreFocusOut: true,
  });
  if (!expression) return;
  await ctx.workspaceState.update('decky-mcp.lastExpression', expression);
  out.appendLine(`> ${expression}`);
  try {
    const result = await client.callToolText('cef_evaluate', { expression });
    out.appendLine(result);
    if (result.length <= 200 && !result.includes('\n')) void vscode.window.showInformationMessage(`Steam: ${result}`);
    else out.show(true);
  } catch (e) {
    out.appendLine(`! ${describeError(e)}`);
    out.show(true);
  }
}

async function writeMcpConfig(c: Connection): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error('open a workspace folder first.');
  const token = await c.token();
  if (!token) {
    await c.client();
    if (!(await c.token())) return;
    return writeMcpConfig(c);
  }
  const uri = vscode.Uri.joinPath(folder.uri, '.mcp.json');
  const ok = await vscode.window.showWarningMessage(
    `Write the Decky-MCP server to ${vscode.workspace.asRelativePath(uri)}?`,
    {
      modal: true,
      detail: 'The bearer token is stored in plain text in that file so MCP clients (Claude Code etc.) can use it. ' +
        'Keep .mcp.json out of version control (add it to .gitignore) if the repository is shared.',
    },
    'Write .mcp.json');
  if (!ok) return;

  let config: { mcpServers?: Record<string, unknown>; [k: string]: unknown } = {};
  try {
    config = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'));
  } catch (e) {
    if (!(e instanceof vscode.FileSystemError)) throw new Error(`existing .mcp.json is not valid JSON: ${describeError(e)}`);
  }
  config.mcpServers = {
    ...(config.mcpServers ?? {}),
    decky: { type: 'http', url: new DeckyClient(c.address).mcpUrl, headers: { Authorization: `Bearer ${token}` } },
  };
  await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(config, null, 2) + '\n'));
  void vscode.window.showInformationMessage('Decky-MCP: wrote mcpServers.decky to .mcp.json.');
}
