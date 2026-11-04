import * as vscode from 'vscode';
import { DeckyClient, describeError, isMissingRoute } from './client';
import { Connection } from './connection';
import { deploy, findPluginFolders, pluginDirName } from './deploy';
import {
  addDevice, changeHost, copyViewerUrl, deviceActions, deviceFrom, editDevice, removeDevice, setActiveDevice, switchDevice,
} from './devices';
import { DevicesTreeProvider, UnifiedTreeProvider } from './devicesTree';
import { DeviceTreeProvider } from './deviceTree';
import { Layout, currentLayout, switchLayout } from './layout';
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
  let layout: Layout = currentLayout();
  c.requireSession = layout !== 'classic';
  await c.initDevices();
  await c.refresh();
  const getLayout = () => layout;
  const status = new StatusBar(c, getLayout);
  const logs = new LogManager(c);
  const deployOut = vscode.window.createOutputChannel('Decky-MCP Deploy');
  const consoleOut = vscode.window.createOutputChannel('Decky-MCP Console');
  const devicesTree = new DevicesTreeProvider(c);
  const deviceTree = new DeviceTreeProvider(c, getLayout);
  const pluginsTree = new PluginsTreeProvider(c, getLayout);
  const unifiedTree = new UnifiedTreeProvider(c);
  const preview = new PreviewViewProvider(ctx.extensionUri, c);
  const devicesView = vscode.window.createTreeView('decky-mcp.devices', { treeDataProvider: devicesTree });
  const deviceView = vscode.window.createTreeView('decky-mcp.device', { treeDataProvider: deviceTree });
  const pluginsView = vscode.window.createTreeView('decky-mcp.plugins', { treeDataProvider: pluginsTree });
  const unifiedView = vscode.window.createTreeView('decky-mcp.unified', { treeDataProvider: unifiedTree });
  ctx.subscriptions.push(
    c, status, logs, deployOut, consoleOut, devicesTree, deviceTree, pluginsTree, unifiedTree,
    devicesView, deviceView, pluginsView, unifiedView,
    vscode.window.registerWebviewViewProvider(PreviewViewProvider.viewId, preview),
  );
  const refreshPlugins = () => {
    pluginsTree.refresh();
    unifiedTree.refreshPlugins();
  };

  const contexts = new Map<string, unknown>();
  const setContext = (key: string, value: unknown) => {
    if (contexts.get(key) === value) return;
    contexts.set(key, value);
    void vscode.commands.executeCommand('setContext', key, value);
  };
  let statsLease: vscode.Disposable | undefined;
  let sessionId: string | undefined;
  const sync = () => {
    const connected = c.connectedDevice;
    setContext('decky-mcp.layout', layout);
    setContext('decky-mcp.paired', c.paired);
    setContext('decky-mcp.connected', !!connected);
    if (connected?.id !== sessionId) {
      sessionId = connected?.id;
      refreshPlugins();
    }
    if (layout === 'classic') {
      deviceView.description = c.paired ? undefined : `${c.label} · not paired`;
      pluginsView.description = undefined;
      preview.setDescription(undefined);
    } else {
      const d = connected && (c.health.kind === 'unreachable' ? `${connected.name} · unreachable` : connected.name);
      deviceView.description = d;
      pluginsView.description = d;
      preview.setDescription(d);
    }
    const wantStats = c.paired && (
      layout === 'classic' ? deviceView.visible
        : !!connected && (layout === 'unified' ? unifiedView.visible : deviceView.visible));
    if (wantStats) {
      statsLease ??= c.watchStats();
    } else {
      statsLease?.dispose();
      statsLease = undefined;
    }
  };
  const applyLayout = () => {
    layout = currentLayout();
    c.requireSession = layout !== 'classic';
    sync();
    devicesTree.refresh();
    deviceTree.refresh();
    pluginsTree.refresh();
    unifiedTree.refresh();
    status.render();
  };
  ctx.subscriptions.push(
    deviceView.onDidChangeVisibility(sync),
    unifiedView.onDidChangeVisibility(sync),
    c.onDidChange(sync),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('decky-mcp.sidebarLayout')) applyLayout();
    }),
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
  command('decky-mcp.pair', async () => {
    const d = c.activeDevice;
    if (d) await pair(c, d);
    else await addDevice(c);
  });
  command('decky-mcp.enterToken', arg => enterToken(c, arg === undefined ? undefined : deviceFrom(c, arg)));
  command('decky-mcp.disconnect', async () => {
    await c.clearToken();
    void vscode.window.showInformationMessage(`Decky-MCP: forgot the token for ${c.label}.`);
  });
  command('decky-mcp.refresh', async () => {
    await c.refresh();
    refreshPlugins();
    await c.probeAll();
  });
  command('decky-mcp.refreshPlugins', async () => refreshPlugins());
  command('decky-mcp.changeHost', () => changeHost(c));
  command('decky-mcp.addDevice', () => addDevice(c));
  command('decky-mcp.editDevice', arg => editDevice(c, arg));
  command('decky-mcp.removeDevice', arg => removeDevice(c, arg));
  command('decky-mcp.setActiveDevice', arg => setActiveDevice(c, layout, arg));
  command('decky-mcp.switchDevice', () => switchDevice(c, layout));
  command('decky-mcp.deviceActions', arg => deviceActions(c, arg));
  command('decky-mcp.copyViewerUrl', arg => copyViewerUrl(c, arg));
  command('decky-mcp.switchLayout', arg => switchLayout(arg));
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
    refreshPlugins();
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

  const last = c.lastSessionDevice;
  if (last && layout !== 'classic') void connect(c, last, false);
  void c.probeAll();
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
