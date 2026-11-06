import * as vscode from 'vscode';
import { homedir } from 'os';
import * as path from 'path';
import { ActionsTreeProvider, WORKSPACE_PLUGIN } from './actionsTree';
import { DeckyClient, describeError, isMissingRoute } from './client';
import { Connection, LinkState, linkSuffix } from './connection';
import { ControllerWatcher, ControllersTreeProvider, addVirtualController, removeVirtualController } from './controllers';
import { DeployController, PluginWorkspace } from './deploy';
import {
  addDevice, deviceActions, deviceFrom, removeDevice, renameDevice,
} from './devices';
import { DevicesTreeProvider } from './devicesTree';
import { DeviceDiscovery } from './discovery';
import { connectFound, searchNetwork } from './discoveryTree';
import {
  GamesTreeProvider, copyDeckyPath, findGame, gameLaunch, gameProtonLog, gameTerminate, openDeckyPath, openGameSaves, openNodeInExplorer,
} from './games';
import { toggleInput } from './input';
import { LogManager } from './logs';
import { navigate, openPluginPanel, simpleNavigate } from './navigation';
import { connect, pair } from './pairing';
import { PluginsTreeProvider } from './pluginsTree';
import { PreviewViewProvider } from './preview';
import { DeckyFileDecorations, DeckyFileSystemProvider, SCHEME } from './remoteFs';
import { ScreenPanel, StatusBar } from './screenPanel';
import { WelcomeViewProvider } from './welcome';

export { connectionTimings } from './connection';
export { pairingTimings } from './pairing';
export { controllerTimings } from './controllers';
export { discoveryHooks, discoveryTimings } from './discovery';

let conn: Connection | undefined;

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  conn = new Connection(ctx);
  const c = conn;
  // Registered before any await so a restored decky:// workspace folder resolves as soon as we activate.
  const remoteFs = new DeckyFileSystemProvider(c);
  ctx.subscriptions.push(remoteFs, vscode.workspace.registerFileSystemProvider(SCHEME, remoteFs, { isCaseSensitive: true }));
  await c.initDevices();
  await c.refresh();
  const status = new StatusBar(c);
  const logs = new LogManager(c);
  const deployOut = vscode.window.createOutputChannel('Decky');
  const consoleOut = vscode.window.createOutputChannel('Decky Toolkit Console');
  const discovery = new DeviceDiscovery(() => c.devices);
  // While nothing is listed the welcome view stands in for the Devices tree, so it also triggers searches.
  const welcome = new WelcomeViewProvider(ctx.extensionUri, () => discoverWhenVisible());
  const devicesTree = new DevicesTreeProvider(c, discovery);
  const workspacePlugins = new PluginWorkspace();
  const actionsTree = new ActionsTreeProvider(c, workspacePlugins);
  const pluginsTree = new PluginsTreeProvider(c);
  const preview = new PreviewViewProvider(ctx.extensionUri, c);
  const devicesView = vscode.window.createTreeView('decky-toolkit.devices', { treeDataProvider: devicesTree });
  const actionsView = vscode.window.createTreeView('decky-toolkit.actions', { treeDataProvider: actionsTree });
  const pluginsView = vscode.window.createTreeView('decky-toolkit.plugins', { treeDataProvider: pluginsTree });
  const gamesTree = new GamesTreeProvider(c);
  const gamesView = vscode.window.createTreeView('decky-toolkit.games', { treeDataProvider: gamesTree, showCollapseAll: true });
  const controllers = new ControllerWatcher(c, () => c.proxy.start());
  const controllersTree = new ControllersTreeProvider(controllers);
  const controllersView = vscode.window.createTreeView('decky-toolkit.controllers', { treeDataProvider: controllersTree });
  ctx.subscriptions.push(
    c, status, logs, deployOut, consoleOut, workspacePlugins, devicesTree, actionsTree, pluginsTree, devicesView, actionsView, pluginsView,
    controllers, controllersTree, controllersView, gamesTree, gamesView,
    vscode.window.registerWebviewViewProvider(PreviewViewProvider.viewId, preview),
    vscode.window.registerWebviewViewProvider(WelcomeViewProvider.viewId, welcome),
    discovery,
  );
  // Searches only while someone looks at the list: when the Devices view opens, or on request.
  const discoverWhenVisible = () => (devicesView.visible || welcome.visible ? discovery.start() : discovery.stop());
  let hasDevicesContext: boolean | undefined;
  const syncHasDevices = () => {
    const has = c.devices.length > 0 || discovery.devices.length > 0;
    if (has === hasDevicesContext) return;
    hasDevicesContext = has;
    void vscode.commands.executeCommand('setContext', 'decky-toolkit.hasDevices', has);
  };
  ctx.subscriptions.push(
    devicesView.onDidChangeVisibility(discoverWhenVisible),
    c.onDidChangeStatus(syncHasDevices),
    discovery.onDidChange(syncHasDevices),
    discovery.onDidChangeState(syncHasDevices),
  );
  syncHasDevices();
  const decorations = new DeckyFileDecorations(c);
  ctx.subscriptions.push(decorations, vscode.window.registerFileDecorationProvider(decorations));
  const refreshPlugins = () => pluginsTree.refresh();

  let connectedContext: boolean | undefined;
  let linkContext: LinkState | undefined | null = null;
  let statsLease: vscode.Disposable | undefined;
  let controllersLease: vscode.Disposable | undefined;
  let sessionId: string | undefined;
  const sync = () => {
    const connected = c.connectedDevice;
    if (connectedContext !== !!connected) {
      connectedContext = !!connected;
      void vscode.commands.executeCommand('setContext', 'decky-toolkit.connected', connectedContext);
    }
    const link = c.link;
    if (link !== linkContext) {
      // The views stay once shown and go empty, so their viewsWelcome for this state takes their place.
      linkContext = link;
      void vscode.commands.executeCommand('setContext', 'decky-toolkit.link', link);
      actionsTree.refresh();
      controllersTree.redraw();
      refreshPlugins();
      gamesTree.refresh();
    }
    if (connected?.id !== sessionId) {
      sessionId = connected?.id;
      refreshPlugins();
      controllersTree.refresh();
      gamesTree.refresh();
    }
    const suffix = linkSuffix(link);
    const d = link && (suffix ? `${c.linkLabel} · ${suffix}` : c.linkLabel);
    actionsView.description = d;
    pluginsView.description = d;
    controllersView.description = d;
    gamesView.description = d;
    preview.setDescription(d);
    if (c.paired && connected && actionsView.visible) {
      statsLease ??= c.watchStats();
    } else {
      statsLease?.dispose();
      statsLease = undefined;
    }
    if (c.paired && connected && controllersView.visible) {
      controllersLease ??= controllers.watch();
    } else {
      controllersLease?.dispose();
      controllersLease = undefined;
    }
  };
  ctx.subscriptions.push(
    actionsView.onDidChangeVisibility(sync),
    controllersView.onDidChangeVisibility(sync),
    c.onDidChange(sync),
    { dispose: () => statsLease?.dispose() },
    { dispose: () => controllersLease?.dispose() },
  );
  sync();

  const afterDeviceChange = async () => {
    await c.checkHealth();
    refreshPlugins();
  };
  const deployer = new DeployController(c, workspacePlugins, deployOut, afterDeviceChange);
  ctx.subscriptions.push(deployer);

  const command = (id: string, fn: (arg?: unknown) => Promise<unknown>) =>
    ctx.subscriptions.push(vscode.commands.registerCommand(id, async (arg?: unknown) => {
      try {
        await fn(arg);
      } catch (e) {
        void vscode.window.showErrorMessage(`Decky Toolkit: ${describeError(e)}`);
      }
    }));

  command('decky-toolkit.connect', async arg => {
    const d = deviceFrom(c, arg);
    if (d) await connect(c, d);
    else await addDevice(c);
  });
  command('decky-toolkit.disconnectDevice', () => c.disconnect());
  command('decky-toolkit.reconnect', async () => {
    const d = c.linkDevice ?? c.activeDevice;
    if (!d) await addDevice(c);
    else if (c.link === 'rejected') await pair(c, d);
    else await connect(c, d);
  });
  command('decky-toolkit.refresh', async () => {
    actionsTree.refresh();
    await c.refresh();
    refreshPlugins();
    await c.probeAll();
  });
  command('decky-toolkit.refreshPlugins', async () => refreshPlugins());
  command('decky-toolkit.addDevice', () => addDevice(c));
  command('decky-toolkit.searchNetwork', () => searchNetwork(discovery));
  command('decky-toolkit.connectFound', arg => connectFound(c, discovery, arg));
  command('decky-toolkit.renameDevice', arg => renameDevice(c, arg));
  command('decky-toolkit.removeDevice', arg => removeDevice(c, arg));
  command('decky-toolkit.deviceActions', arg => deviceActions(c, arg));
  command('decky-toolkit.openScreen', async () => {
    if (await c.client()) await ScreenPanel.show(ctx, c, controllers);
  });
  command('decky-toolkit.snapshot', () => snapshot(c));
  command('decky-toolkit.toggleInput', () => toggleInput(c));
  command('decky-toolkit.screen.inputOn', () => toggleInput(c, true));
  command('decky-toolkit.screen.inputOff', () => toggleInput(c, false));
  command('decky-toolkit.screen.mute', async () => ScreenPanel.mute(true));
  command('decky-toolkit.screen.unmute', async () => ScreenPanel.mute(false));
  command('decky-toolkit.screen.pause', async () => ScreenPanel.pause(true));
  command('decky-toolkit.screen.resume', async () => ScreenPanel.pause(false));
  command('decky-toolkit.screen.settings', () => ScreenPanel.settings());
  command('decky-toolkit.addVirtualController', () => addVirtualController(c, controllers));
  command('decky-toolkit.removeVirtualController', arg => removeVirtualController(c, controllers, arg));
  command('decky-toolkit.refreshControllers', async () => controllersTree.refresh());
  command('decky-toolkit.navigate', () => navigate(c));
  command('decky-toolkit.openPluginPanel', arg => openPluginPanel(c, arg));
  command('decky-toolkit.uiBack', () => simpleNavigate(c, { action: 'back' }));
  command('decky-toolkit.uiQuickAccess', () => simpleNavigate(c, { action: 'quick_access' }));
  command('decky-toolkit.uiCloseMenus', () => simpleNavigate(c, { action: 'close_menus' }));
  command('decky-toolkit.findGame', () => findGame(c, gamesTree, gamesView));
  command('decky-toolkit.refreshGames', async () => gamesTree.refresh());
  command('decky-toolkit.openGameSaves', arg => openGameSaves(c, gamesTree, arg));
  command('decky-toolkit.openDeckyPath', () => openDeckyPath(c));
  command('decky-toolkit.gameLaunch', arg => gameLaunch(c, gamesTree, arg));
  command('decky-toolkit.gameTerminate', arg => gameTerminate(c, gamesTree, arg));
  command('decky-toolkit.gameProtonLog', arg => gameProtonLog(c, gamesTree, arg));
  command('decky-toolkit.openInExplorer', arg => openNodeInExplorer(c, arg));
  command('decky-toolkit.copyDeckyPath', arg => copyDeckyPath(arg));
  command('decky-toolkit.deploy', () => deployer.deploy());
  command('decky-toolkit.deployFull', () => deployer.deploy({ full: true }));
  command('decky-toolkit.toggleAutoDeploy', async () => {
    if (await workspacePlugins.pick('Auto-deploy which plugin?')) await deployer.toggleAutoDeploy();
  });
  command('decky-toolkit.installZip', async () => {
    try {
      await installZip(c);
    } finally {
      await afterDeviceChange();
    }
  });
  command('decky-toolkit.restartLoader', async () => {
    const client = await c.client();
    if (!client) return;
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Restarting Decky Loader' }, async progress => {
        await client.restartLoader();
        progress.report({ message: 'waiting for it to come back…' });
        const h = await client.waitForRestart();
        void vscode.window.showInformationMessage(`Decky Toolkit: loader restarted (${h.name} ${h.version}).`);
      });
    } finally {
      await afterDeviceChange();
    }
  });
  command('decky-toolkit.reloadPlugin', async arg => {
    const client = await c.client();
    const dir = client && await resolveDir(client, workspacePlugins, arg, 'Plugin to reload');
    if (!client || !dir) return;
    try {
      await client.reloadPlugin(dir);
    } catch (e) {
      if (isMissingRoute(e)) {
        throw new Error('the Decky Toolkit plugin on the device has no POST /plugins/{dir}/reload yet; update it, or use "Decky: Restart loader".');
      }
      throw e;
    }
    void vscode.window.showInformationMessage(`Decky Toolkit: reloaded ${dir}.`);
    refreshPlugins();
  });
  command('decky-toolkit.loaderLogs', async () => {
    if (await c.client()) logs.show('loader', 'Decky Loader', { source: 'loader' });
  });
  command('decky-toolkit.pluginLogs', async arg => {
    const client = await c.client();
    const dir = client && await resolveDir(client, workspacePlugins, arg, 'Show logs of which plugin?');
    if (dir) logs.show(`plugin:${dir}`, `Decky: ${dir}`, { source: 'plugin', plugin: dir });
  });
  command('decky-toolkit.evaluate', () => evaluate(c, consoleOut, ctx));
  command('decky-toolkit.toast', async () => {
    const client = await c.client();
    if (!client) return;
    const body = await vscode.window.showInputBox({ prompt: 'Toast text to show on the device', value: 'Hello from VS Code' });
    if (!body) return;
    await client.callToolText('toast', { title: 'VS Code', body });
  });
  command('decky-toolkit.writeMcpConfig', () => writeMcpConfig(c));
  command('decky-toolkit.copyMcpUrl', async () => {
    if (!(await c.client())) return;
    const url = await c.proxy.mcpUrl();
    await vscode.env.clipboard.writeText(url);
    void vscode.window.showInformationMessage(`Decky Toolkit: copied ${url}. It works while VS Code is open and reaches the connected device.`);
  });
  // MCP clients reach the device only through this window's proxy, so it runs from the start.
  void c.proxy.start().then(() => refreshMcpConfig(c), () => undefined);

  await ScreenPanel.replaceOrphan(ctx, c, controllers);
  const last = c.lastSessionDevice;
  if (last) void connect(c, last, false);
  void c.probeAll();
  discoverWhenVisible();
  // A session that was lost before this window started (or never came up) resumes once the device answers.
  let lastDown = false;
  ctx.subscriptions.push(c.onDidChangeStatus(() => {
    const want = c.connectedDevice ? undefined : c.lastSessionDevice;
    const status = want && c.statusOf(want);
    if (lastDown && status === 'disconnected') void connect(c, want!, false);
    lastDown = status === 'unreachable';
  }));
}

export function deactivate(): void {
  conn?.dispose();
  conn = undefined;
}

/**
 * Plugins view rows pass themselves, the Actions view's Plugin group passes WORKSPACE_PLUGIN, and the
 * palette passes nothing (then pick from the workspace and the device).
 */
async function resolveDir(client: DeckyClient, ws: PluginWorkspace, arg: unknown, placeHolder: string): Promise<string | undefined> {
  if (arg === WORKSPACE_PLUGIN) return (await ws.pick(placeHolder))?.dir;
  if (typeof arg === 'string') return arg;
  const dir = (arg as { info?: { dir?: unknown } } | undefined)?.info?.dir;
  return typeof dir === 'string' ? dir : pickDeviceDir(client, ws, placeHolder);
}

async function snapshot(c: Connection): Promise<void> {
  const client = await c.client();
  if (!client) return;
  const jpeg = await client.frame();
  const stamp = new Date().toISOString().replace(/\.\d+Z$/, '').replace(/:/g, '-');
  const name = `screen-${stamp}.jpg`;
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  const uri = await vscode.window.showSaveDialog({
    defaultUri: folder ? vscode.Uri.joinPath(folder, name) : vscode.Uri.file(path.join(homedir(), name)),
    filters: { 'JPEG image': ['jpg', 'jpeg'] },
    saveLabel: 'Save snapshot',
    title: `Save a snapshot of ${c.label}`,
  });
  if (!uri) return;
  await vscode.workspace.fs.writeFile(uri, jpeg);
  const choice = await vscode.window.showInformationMessage(`Decky Toolkit: saved ${vscode.workspace.asRelativePath(uri)}.`, 'Open');
  if (choice === 'Open') await vscode.commands.executeCommand('vscode.open', uri);
}

async function installZip(c: Connection): Promise<void> {
  const client = await c.client();
  if (!client) return;
  const [uri] = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: { 'Plugin zip': ['zip'] },
    openLabel: 'Install on device',
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
      if (isMissingRoute(e)) throw new Error('the Decky Toolkit plugin on the device has no POST /plugins/install yet; update it.');
      throw e;
    }
    if (result.restarted === 'loader') {
      progress.report({ message: 'waiting for the loader to restart…' });
      await client.waitForRestart();
    }
    const { name, version, dir } = result.installed;
    void vscode.window.showInformationMessage(`Decky Toolkit: installed ${name}${version ? ` ${version}` : ''} as ${dir}.`);
  });
}

async function pickDeviceDir(client: DeckyClient, ws: PluginWorkspace, placeHolder: string): Promise<string | undefined> {
  const local = (await ws.ready()).map(p => p.dir);
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
    value: ctx.workspaceState.get<string>('decky-toolkit.lastExpression', 'window.DeckyPluginLoader?.version'),
    ignoreFocusOut: true,
  });
  if (!expression) return;
  await ctx.workspaceState.update('decky-toolkit.lastExpression', expression);
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

type McpConfig = { mcpServers?: Record<string, unknown>; [k: string]: unknown };

function mcpConfigUri(): vscode.Uri | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder && vscode.Uri.joinPath(folder.uri, '.mcp.json');
}

/** Undefined when the file does not exist. */
async function readMcpConfig(uri: vscode.Uri): Promise<McpConfig | undefined> {
  let raw: Uint8Array;
  try {
    raw = await vscode.workspace.fs.readFile(uri);
  } catch (e) {
    if (e instanceof vscode.FileSystemError) return undefined;
    throw e;
  }
  try {
    return JSON.parse(Buffer.from(raw).toString('utf8'));
  } catch (e) {
    throw new Error(`existing .mcp.json is not valid JSON: ${describeError(e)}`);
  }
}

async function writeMcpEntry(uri: vscode.Uri, config: McpConfig, entry: Record<string, unknown>): Promise<void> {
  config.mcpServers = { ...(config.mcpServers ?? {}), decky: entry };
  await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(config, null, 2) + '\n'));
}

async function writeMcpConfig(c: Connection): Promise<void> {
  const uri = mcpConfigUri();
  if (!uri) throw new Error('open a workspace folder first.');
  if (!(await c.client())) return;
  await writeMcpEntry(uri, (await readMcpConfig(uri)) ?? {}, { type: 'http', url: await c.proxy.mcpUrl() });
  void vscode.window.showInformationMessage('Decky Toolkit: wrote mcpServers.decky to .mcp.json.');
}

/** Points a `.mcp.json` written by an earlier session at this window's proxy port, if that moved. */
export async function refreshMcpConfig(c: Pick<Connection, 'proxy'>): Promise<void> {
  const uri = mcpConfigUri();
  if (!uri) return;
  let config: McpConfig | undefined;
  try {
    config = await readMcpConfig(uri);
  } catch {
    return;
  }
  const entry = config?.mcpServers?.decky as Record<string, unknown> | undefined;
  const url = typeof entry?.url === 'string' ? await c.proxy.rebase(entry.url) : undefined;
  if (config && entry && url) await writeMcpEntry(uri, config, { ...entry, url });
}
