import * as vscode from 'vscode';
import { homedir } from 'os';
import * as path from 'path';
import { ActionsTreeProvider, WORKSPACE_PLUGIN } from './actionsTree';
import { DeckyClient, describeError, isMissingRoute } from './client';
import { Connection } from './connection';
import { deploy, findPluginFolders, pickPluginFolder, pluginDirName } from './deploy';
import {
  addDevice, changeHost, copyViewerUrl, deviceActions, deviceFrom, editDevice, removeDevice, switchDevice, viewerUrl,
} from './devices';
import { DevicesTreeProvider } from './devicesTree';
import { toggleInput } from './input';
import { LogManager } from './logs';
import { connect, enterToken, pair } from './pairing';
import { PluginsTreeProvider } from './pluginsTree';
import { PreviewViewProvider } from './preview';
import { ScreenPanel, StatusBar } from './screenPanel';

export { connectionTimings } from './connection';
export { pairingTimings } from './pairing';

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
  const devicesTree = new DevicesTreeProvider(c);
  const actionsTree = new ActionsTreeProvider(c);
  const pluginsTree = new PluginsTreeProvider(c);
  const preview = new PreviewViewProvider(ctx.extensionUri, c);
  const devicesView = vscode.window.createTreeView('decky-mcp.devices', { treeDataProvider: devicesTree });
  const actionsView = vscode.window.createTreeView('decky-mcp.actions', { treeDataProvider: actionsTree });
  const pluginsView = vscode.window.createTreeView('decky-mcp.plugins', { treeDataProvider: pluginsTree });
  ctx.subscriptions.push(
    c, status, logs, deployOut, consoleOut, devicesTree, actionsTree, pluginsTree, devicesView, actionsView, pluginsView,
    vscode.window.registerWebviewViewProvider(PreviewViewProvider.viewId, preview),
  );
  const refreshPlugins = () => pluginsTree.refresh();

  let connectedContext: boolean | undefined;
  let statsLease: vscode.Disposable | undefined;
  let sessionId: string | undefined;
  const sync = () => {
    const connected = c.connectedDevice;
    if (connectedContext !== !!connected) {
      connectedContext = !!connected;
      void vscode.commands.executeCommand('setContext', 'decky-mcp.connected', connectedContext);
    }
    if (connected?.id !== sessionId) {
      sessionId = connected?.id;
      refreshPlugins();
    }
    const d = connected && (c.health.kind === 'unreachable' ? `${connected.name} · unreachable` : connected.name);
    actionsView.description = d;
    pluginsView.description = d;
    preview.setDescription(d);
    if (c.paired && connected && actionsView.visible) {
      statsLease ??= c.watchStats();
    } else {
      statsLease?.dispose();
      statsLease = undefined;
    }
  };
  ctx.subscriptions.push(
    actionsView.onDidChangeVisibility(sync),
    c.onDidChange(sync),
    { dispose: () => statsLease?.dispose() },
  );
  sync();

  const afterDeviceChange = async () => {
    await c.checkHealth();
    refreshPlugins();
  };

  const command = (id: string, fn: (arg?: unknown) => Promise<unknown>) =>
    ctx.subscriptions.push(vscode.commands.registerCommand(id, async (arg?: unknown) => {
      try {
        await fn(arg);
      } catch (e) {
        void vscode.window.showErrorMessage(`Decky-MCP: ${describeError(e)}`);
      }
    }));

  command('decky-mcp.connect', async arg => {
    const d = deviceFrom(c, arg);
    if (d) await connect(c, d);
    else await addDevice(c);
  });
  command('decky-mcp.disconnectDevice', () => c.disconnect());
  command('decky-mcp.pairAgain', async arg => {
    const d = deviceFrom(c, arg);
    if (d) await pair(c, d);
  });
  command('decky-mcp.enterToken', arg => enterToken(c, arg === undefined ? undefined : deviceFrom(c, arg)));
  command('decky-mcp.disconnect', async () => {
    await c.clearToken();
    void vscode.window.showInformationMessage(`Decky-MCP: forgot the token for ${c.label}.`);
  });
  command('decky-mcp.refresh', async () => {
    actionsTree.refresh();
    await c.refresh();
    refreshPlugins();
    await c.probeAll();
  });
  command('decky-mcp.refreshPlugins', async () => refreshPlugins());
  command('decky-mcp.changeHost', () => changeHost(c));
  command('decky-mcp.addDevice', () => addDevice(c));
  command('decky-mcp.editDevice', arg => editDevice(c, arg));
  command('decky-mcp.removeDevice', arg => removeDevice(c, arg));
  command('decky-mcp.switchDevice', () => switchDevice(c));
  command('decky-mcp.deviceActions', arg => deviceActions(c, arg));
  command('decky-mcp.copyViewerUrl', arg => copyViewerUrl(c, arg));
  command('decky-mcp.openScreen', async () => {
    if (await c.client()) await ScreenPanel.show(ctx, c);
  });
  command('decky-mcp.openViewer', async () => {
    const d = (await c.client()) && c.connectedDevice;
    if (d) await vscode.env.openExternal(vscode.Uri.parse(viewerUrl(d)));
  });
  command('decky-mcp.snapshot', () => snapshot(c));
  command('decky-mcp.toggleInput', () => toggleInput(c));
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
    const dir = client && await resolveDir(client, arg, 'Plugin to reload');
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
    refreshPlugins();
  });
  command('decky-mcp.loaderLogs', async () => {
    if (await c.client()) logs.show('loader', 'Decky Loader', { source: 'loader' });
  });
  command('decky-mcp.pluginLogs', async arg => {
    const client = await c.client();
    const dir = client && await resolveDir(client, arg, 'Show logs of which plugin?');
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
  command('decky-mcp.copyMcpUrl', async () => {
    if (!(await c.client())) return;
    const url = new DeckyClient(c.address).mcpUrl;
    await vscode.env.clipboard.writeText(url);
    void vscode.window.showInformationMessage(`Decky-MCP: copied ${url}. MCP clients also need the bearer token (MCP → Copy token).`);
  });
  command('decky-mcp.copyToken', async () => {
    const token = (await c.client()) && await c.token();
    if (!token) return;
    await vscode.env.clipboard.writeText(token);
    void vscode.window.showWarningMessage(
      `Decky-MCP: copied the bearer token for ${c.label}. It is a secret: anyone with it can control the Deck, so keep it out of shared files and chats.`);
  });

  const last = c.lastSessionDevice;
  if (last) void connect(c, last, false);
  void c.probeAll();
}

export function deactivate(): void {
  conn?.dispose();
  conn = undefined;
}

/**
 * Plugins view rows pass themselves, the Actions view's Plugin group passes WORKSPACE_PLUGIN, and the
 * palette passes nothing (then pick from the workspace and the Deck).
 */
async function resolveDir(client: DeckyClient, arg: unknown, placeHolder: string): Promise<string | undefined> {
  if (arg === WORKSPACE_PLUGIN) {
    const p = await pickPluginFolder();
    return p && pluginDirName(p);
  }
  if (typeof arg === 'string') return arg;
  const dir = (arg as { info?: { dir?: unknown } } | undefined)?.info?.dir;
  return typeof dir === 'string' ? dir : pickDeviceDir(client, placeHolder);
}

async function snapshot(c: Connection): Promise<void> {
  const client = await c.client();
  if (!client) return;
  const jpeg = await client.frame();
  const stamp = new Date().toISOString().replace(/\.\d+Z$/, '').replace(/:/g, '-');
  const name = `deck-${stamp}.jpg`;
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  const uri = await vscode.window.showSaveDialog({
    defaultUri: folder ? vscode.Uri.joinPath(folder, name) : vscode.Uri.file(path.join(homedir(), name)),
    filters: { 'JPEG image': ['jpg', 'jpeg'] },
    saveLabel: 'Save snapshot',
    title: `Save a snapshot of ${c.label}`,
  });
  if (!uri) return;
  await vscode.workspace.fs.writeFile(uri, jpeg);
  const choice = await vscode.window.showInformationMessage(`Decky-MCP: saved ${vscode.workspace.asRelativePath(uri)}.`, 'Open');
  if (choice === 'Open') await vscode.commands.executeCommand('vscode.open', uri);
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
