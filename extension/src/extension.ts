import * as vscode from 'vscode';
import { DeckyClient, HttpError, describeError, isMissingRoute, sleep } from './client';
import { Connection } from './connection';
import { deploy, findPluginFolders, pluginDirName } from './deploy';
import { addDevice, changeHost, editDevice, removeDevice, setActiveDevice, switchDevice } from './devices';
import { DeviceTreeProvider } from './deviceTree';
import { LogManager } from './logs';
import { PluginsTreeProvider } from './pluginsTree';
import { PreviewViewProvider } from './preview';
import { ScreenPanel, StatusBar } from './screenPanel';

const PAIR_TIMEOUT_MS = 120_000;
const PAIR_POLL_MS = 2000;

let conn: Connection | undefined;

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  conn = new Connection(ctx);
  const c = conn;
  await c.initDevices();
  await c.refresh();
  const status = new StatusBar(c);
  const logs = new LogManager(c);
  const deployOut = vscode.window.createOutputChannel('Decky-MCP Deploy');
  const consoleOut = vscode.window.createOutputChannel('Decky-MCP Console');
  const deviceTree = new DeviceTreeProvider(c);
  const pluginsTree = new PluginsTreeProvider(c);
  const deviceView = vscode.window.createTreeView('decky-mcp.device', { treeDataProvider: deviceTree });
  const pluginsView = vscode.window.createTreeView('decky-mcp.plugins', { treeDataProvider: pluginsTree });
  ctx.subscriptions.push(
    c, status, logs, deployOut, consoleOut, deviceTree, pluginsTree, deviceView, pluginsView,
    vscode.window.registerWebviewViewProvider(PreviewViewProvider.viewId, new PreviewViewProvider(ctx.extensionUri, c)),
  );

  let statsLease: vscode.Disposable | undefined;
  const sync = () => {
    void vscode.commands.executeCommand('setContext', 'decky-mcp.paired', c.paired);
    deviceView.description = c.paired ? undefined : `${c.label} · not paired`;
    if (deviceView.visible && c.paired) {
      statsLease ??= c.watchStats();
    } else {
      statsLease?.dispose();
      statsLease = undefined;
    }
  };
  ctx.subscriptions.push(
    deviceView.onDidChangeVisibility(sync),
    c.onDidChangeTarget(sync),
    { dispose: () => statsLease?.dispose() },
  );
  sync();

  const afterDeviceChange = async () => {
    await c.checkHealth();
    pluginsTree.refresh();
  };

  const command = (id: string, fn: (arg?: unknown) => Promise<unknown>) =>
    ctx.subscriptions.push(vscode.commands.registerCommand(id, async (arg?: unknown) => {
      try {
        await fn(arg);
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
  command('decky-mcp.refresh', async () => {
    await c.refresh();
    pluginsTree.refresh();
  });
  command('decky-mcp.refreshPlugins', async () => pluginsTree.refresh());
  command('decky-mcp.changeHost', () => changeHost(c));
  command('decky-mcp.addDevice', () => addDevice(c));
  command('decky-mcp.editDevice', arg => editDevice(c, arg));
  command('decky-mcp.removeDevice', arg => removeDevice(c, arg));
  command('decky-mcp.setActiveDevice', arg => setActiveDevice(c, arg));
  command('decky-mcp.switchDevice', () => switchDevice(c));
  command('decky-mcp.openScreen', async () => {
    if (await c.client()) await ScreenPanel.show(ctx, c);
  });
  command('decky-mcp.deploy', async () => {
    const client = await c.client();
    if (!client) return;
    try {
      await deploy(client, deployOut);
    } finally {
      await afterDeviceChange();
    }
  });
  command('decky-mcp.installZip', async () => {
    try {
      await installZip(c);
    } finally {
      await afterDeviceChange();
    }
  });
  command('decky-mcp.restartLoader', async () => {
    const client = await c.client();
    if (!client) return;
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Restarting Decky Loader' }, async progress => {
        await client.restartLoader();
        progress.report({ message: 'waiting for it to come back…' });
        const h = await client.waitForRestart();
        void vscode.window.showInformationMessage(`Decky-MCP: loader restarted (${h.name} ${h.version}).`);
      });
    } finally {
      await afterDeviceChange();
    }
  });
  command('decky-mcp.reloadPlugin', async arg => {
    const client = await c.client();
    const dir = client && (dirFrom(arg) ?? await pickDeviceDir(client, 'Plugin to reload'));
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
    pluginsTree.refresh();
  });
  command('decky-mcp.loaderLogs', async () => {
    if (await c.client()) logs.show('loader', 'Decky Loader', { source: 'loader' });
  });
  command('decky-mcp.pluginLogs', async arg => {
    const client = await c.client();
    const dir = client && (dirFrom(arg) ?? await pickDeviceDir(client, 'Show logs of which plugin?'));
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

/** Tree items pass themselves as the command argument; palette invocations pass nothing. */
function dirFrom(arg: unknown): string | undefined {
  if (typeof arg === 'string') return arg;
  const dir = (arg as { info?: { dir?: unknown } } | undefined)?.info?.dir;
  return typeof dir === 'string' ? dir : undefined;
}

async function installZip(c: Connection): Promise<void> {
  const client = await c.client();
  if (!client) return;
  const [uri] = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: { 'Plugin zip': ['zip'] },
    openLabel: 'Install on Deck',
    title: `Install a Decky plugin zip on ${c.label}`,
  }) ?? [];
  if (!uri) return;
  const filename = uri.path.split('/').pop() || 'plugin.zip';
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Installing ${filename} on ${c.label}` }, async progress => {
    const data = await vscode.workspace.fs.readFile(uri);
    progress.report({ message: `uploading ${(data.length / 1024).toFixed(0)} KiB…` });
    let result;
    try {
      result = await client.installPlugin(data, filename, 'loader');
    } catch (e) {
      if (isMissingRoute(e)) throw new Error('the Decky-MCP plugin on the device has no POST /plugins/install yet; update it.');
      throw e;
    }
    if (result.restarted === 'loader') {
      progress.report({ message: 'waiting for the loader to restart…' });
      await client.waitForRestart();
    }
    const { name, version, dir } = result.installed;
    void vscode.window.showInformationMessage(`Decky-MCP: installed ${name}${version ? ` ${version}` : ''} as ${dir}.`);
  });
}

async function pair(c: Connection): Promise<void> {
  const client = c.unauthenticatedClient();
  try {
    await client.health();
  } catch (e) {
    throw new Error(`cannot reach ${client.baseUrl} (${describeError(e)}). Use "Change host" or edit the device.`);
  }
  const offerManual = async (why: string) => {
    const choice = await vscode.window.showWarningMessage(`Decky-MCP: ${why}`, 'Enter token manually');
    if (choice) await enterToken(c);
  };

  const grant = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Pairing with ${c.label}`, cancellable: true },
    async (progress, token) => {
      const start = Date.now();
      const abort = new AbortController();
      const cancelSub = token.onCancellationRequested(() => abort.abort());
      const report = () => {
        const left = Math.max(0, Math.ceil((PAIR_TIMEOUT_MS - (Date.now() - start)) / 1000));
        progress.report({ message: `Waiting for the Deck… ${left} s left. Press "Pair a browser" in the Decky-MCP panel.` });
      };
      report();
      const ticker = setInterval(report, 1000);
      try {
        while (!abort.signal.aborted && Date.now() - start < PAIR_TIMEOUT_MS) {
          try {
            const r = await client.pair();
            if (r === 'unsupported') return 'unsupported' as const;
            if (r !== 'closed') return r;
          } catch {
            // transient (loader restarting); keep polling
          }
          await sleep(PAIR_POLL_MS, abort.signal).catch(() => undefined);
        }
        return abort.signal.aborted ? 'cancelled' as const : 'timeout' as const;
      } finally {
        clearInterval(ticker);
        cancelSub.dispose();
      }
    });

  if (grant === 'cancelled') return;
  if (grant === 'unsupported') {
    return offerManual('this device has no /pair route yet (older Decky-MCP). Copy the token from the Decky-MCP panel instead.');
  }
  if (grant === 'timeout') return offerManual('no pairing window was opened within 120 s.');
  await c.setToken(grant.token);
  await announce(c, 'Paired with');
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
    const choice = await vscode.window.showInformationMessage(
      `Decky-MCP: ${verb} ${c.label}: ${h.name} ${h.version}, API v${h.api_version}, ${h.tools} tools.`, 'Open screen');
    if (choice) await vscode.commands.executeCommand('decky-mcp.openScreen');
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
