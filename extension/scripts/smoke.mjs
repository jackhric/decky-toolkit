// Activation smoke test against a stub `vscode` module; needs no device and no VS Code.
// Usage: node scripts/smoke.mjs
import * as esbuild from 'esbuild';
import assert from 'assert/strict';
import Module, { createRequire } from 'module';
import { readFileSync } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

const outfile = path.join(root, 'out', 'smoke.cjs');
await esbuild.build({
  stdin: {
    contents: "export * from './src/extension'; export * from './src/deviceTree'; export * from './src/pluginsTree';",
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile,
  external: ['vscode'],
  logLevel: 'warning',
});

const calls = { treeViews: [], treeProviders: [], webviewProviders: [], commands: new Map(), context: new Map(), statusItems: [] };

class EventEmitter {
  listeners = new Set();
  event = (fn, thisArg, disposables) => {
    const l = thisArg ? fn.bind(thisArg) : fn;
    this.listeners.add(l);
    const d = { dispose: () => this.listeners.delete(l) };
    disposables?.push(d);
    return d;
  };
  fire(v) { for (const l of [...this.listeners]) l(v); }
  dispose() { this.listeners.clear(); }
}
class Disposable { constructor(fn) { this.fn = fn; } dispose() { this.fn?.(); } }
class TreeItem { constructor(label, collapsibleState = 0) { this.label = label; this.collapsibleState = collapsibleState; } }
class ThemeIcon { constructor(id) { this.id = id; } }
class MarkdownString { value = ''; appendMarkdown(s) { this.value += s; return this; } }
const Uri = {
  parse: s => ({ toString: () => s, path: new URL(s).pathname }),
  joinPath: (u, ...p) => ({ toString: () => [u.toString(), ...p].join('/'), path: [u.path ?? '', ...p].join('/') }),
};

const settings = { host: '10.1.2.3', port: 8765, pluginDirName: '' };
const configEmitter = new EventEmitter();
const noop = async () => undefined;
const vscode = {
  EventEmitter, Disposable, TreeItem, ThemeIcon, MarkdownString, Uri,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
  ViewColumn: { Beside: -2 },
  QuickPickItemKind: { Separator: -1, Default: 0 },
  ConfigurationTarget: { Global: 1, Workspace: 2 },
  FileSystemError: class extends Error {},
  CancellationError: class extends Error {},
  window: {
    createStatusBarItem: () => {
      const item = { text: '', tooltip: '', show() {}, dispose() {} };
      calls.statusItems.push(item);
      return item;
    },
    createOutputChannel: () => ({ appendLine() {}, append() {}, show() {}, dispose() {} }),
    createTreeView: (id, opts) => {
      const visibility = new EventEmitter();
      const view = { id, visible: true, description: undefined, onDidChangeVisibility: visibility.event, dispose() {}, _visibility: visibility };
      calls.treeViews.push({ id, provider: opts.treeDataProvider, view });
      return view;
    },
    registerTreeDataProvider: (id, provider) => { calls.treeProviders.push({ id, provider }); return new Disposable(); },
    registerWebviewViewProvider: (id, provider) => { calls.webviewProviders.push({ id, provider }); return new Disposable(); },
    showErrorMessage: async m => { throw new Error(`unexpected error message: ${m}`); },
    showWarningMessage: noop, showInformationMessage: noop, showInputBox: noop, showQuickPick: noop, showOpenDialog: noop,
    withProgress: (_o, fn) => fn({ report() {} }, { isCancellationRequested: false, onCancellationRequested: () => new Disposable() }),
  },
  commands: {
    registerCommand: (id, fn) => { calls.commands.set(id, fn); return new Disposable(() => calls.commands.delete(id)); },
    executeCommand: async (id, ...args) => {
      if (id === 'setContext') { calls.context.set(args[0], args[1]); return; }
      return calls.commands.get(id)?.(...args);
    },
  },
  workspace: {
    getConfiguration: () => ({ get: (k, d) => settings[k] ?? d, inspect: () => ({}), update: noop }),
    onDidChangeConfiguration: configEmitter.event,
    workspaceFolders: undefined,
    fs: { readFile: async () => { throw new vscode.FileSystemError('nope'); } },
    asRelativePath: p => String(p),
  },
  env: { asExternalUri: async u => u, openExternal: noop },
};

const realLoad = Module._load;
Module._load = function (request, ...rest) {
  return request === 'vscode' ? vscode : realLoad.call(this, request, ...rest);
};
const ext = createRequire(import.meta.url)(outfile);

const secretsEmitter = new EventEmitter();
const secrets = new Map();
const globalState = new Map();
const ctx = {
  subscriptions: [],
  extensionUri: Uri.parse('file:///ext'),
  secrets: {
    get: async k => secrets.get(k),
    store: async (k, v) => { secrets.set(k, v); secretsEmitter.fire({ key: k }); },
    delete: async k => { secrets.delete(k); secretsEmitter.fire({ key: k }); },
    onDidChange: secretsEmitter.event,
  },
  globalState: { get: (k, d) => (globalState.has(k) ? globalState.get(k) : d), update: async (k, v) => { globalState.set(k, v); } },
  workspaceState: { get: (_k, d) => d, update: noop },
};

// Fake device behind global fetch so the real DeckyClient can be exercised during activation.
const health = { ok: true, name: 'decky-mcp', version: '0.2.0', api_version: 1, tools: 15 };
const stats = { available: true, running: true, subscribers: 1, fps: 30, kbps: 19542, frames_total: 10, uptime_s: 1, width: 1920, height: 1080, settings: { fps: 30, quality: 70, width: 0 }, error: null };
const plugins = [
  { dir: 'decky-mcp', name: 'Decky-MCP', author: 'jackh', flags: ['root', 'debug'], api_version: 1, version: '0.1.0', has_backend: true },
  { dir: 'romm-tender', name: 'Tender', author: 'x', flags: [], api_version: 1, version: '0.33.0', has_backend: true },
];
const fetched = [];
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  const auth = new Headers(init.headers).get('authorization');
  fetched.push(u.pathname);
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (u.pathname === '/health') return json(health);
  if (auth !== 'Bearer fake-token') return new Response('unauthorized', { status: 401 });
  if (u.pathname === '/stream/stats') return json(stats);
  if (u.pathname === '/plugins') return json(plugins);
  return new Response('not found', { status: 404 });
};

const results = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    results.push(true);
    console.log(`PASS  ${name}${detail ? `: ${detail}` : ''}`);
  } catch (e) {
    results.push(false);
    console.log(`FAIL  ${name}: ${e.stack ?? e}`);
  }
}
const settle = () => new Promise(r => setTimeout(r, 50));
const labels = items => items.map(i => i.label);

await ext.activate(ctx);
await settle();

const deviceProvider = () => calls.treeViews.find(t => t.id === 'decky-mcp.device')?.provider;
const pluginsProvider = () => calls.treeViews.find(t => t.id === 'decky-mcp.plugins')?.provider;

await check('activate() registers the three views', async () => {
  const trees = [...calls.treeViews.map(t => t.id), ...calls.treeProviders.map(t => t.id)].sort();
  assert.deepEqual(trees, ['decky-mcp.device', 'decky-mcp.plugins']);
  assert.deepEqual(calls.webviewProviders.map(w => w.id), ['decky-mcp.preview']);
  const declared = pkg.contributes.views['decky-mcp'].map(v => v.id).sort();
  assert.deepEqual(declared, ['decky-mcp.device', 'decky-mcp.plugins', 'decky-mcp.preview']);
  return `createTreeView(${trees.join(', ')}), registerWebviewViewProvider(decky-mcp.preview)`;
});

await check('package.json: container, activation and command wiring', async () => {
  const container = pkg.contributes.viewsContainers.activitybar[0];
  assert.equal(container.id, 'decky-mcp');
  assert.equal(container.title, 'Decky');
  assert.equal(readFileSync(path.join(root, container.icon), 'utf8').includes('currentColor'), true);
  for (const v of ['decky-mcp.device', 'decky-mcp.plugins', 'decky-mcp.preview']) assert.ok(pkg.activationEvents.includes(`onView:${v}`), v);
  assert.ok(pkg.activationEvents.includes('workspaceContains:plugin.json'));
  const declared = new Set(pkg.contributes.commands.map(c => c.command));
  const registered = new Set(calls.commands.keys());
  for (const id of declared) assert.ok(registered.has(id), `declared but not registered: ${id}`);
  for (const id of registered) assert.ok(declared.has(id), `registered but not declared: ${id}`);
  const menuCmds = Object.values(pkg.contributes.menus).flat().map(m => m.command);
  for (const id of menuCmds) assert.ok(declared.has(id), `menu refers to unknown command ${id}`);
  const welcome = pkg.contributes.viewsWelcome.map(w => w.view).sort();
  assert.deepEqual(welcome, ['decky-mcp.device', 'decky-mcp.plugins']);
  return `${declared.size} commands registered, ${menuCmds.length} menu entries resolve`;
});

await check('first activation seeds one saved device from the settings', async () => {
  const list = globalState.get('decky-mcp.devices');
  assert.equal(list.length, 1);
  assert.equal(list[0].host, '10.1.2.3');
  assert.equal(globalState.get('decky-mcp.activeDevice'), list[0].id);
  return JSON.stringify({ name: list[0].name, host: list[0].host, port: list[0].port });
});

await check('not paired: empty trees (welcome content shows), context key false, status bar', async () => {
  assert.deepEqual(await deviceProvider().getChildren(), []);
  assert.deepEqual(await pluginsProvider().getChildren(), []);
  assert.equal(calls.context.get('decky-mcp.paired'), false);
  const view = calls.treeViews.find(t => t.id === 'decky-mcp.device').view;
  assert.match(view.description, /not paired/);
  assert.match(calls.statusItems[0].text, /\(not paired\)/);
  return `device view description "${view.description}", status "${calls.statusItems[0].text}"`;
});

await check('paired (via secret storage + fake device): device and plugin roots', async () => {
  await ctx.secrets.store('decky-mcp.token:10.1.2.3:8765', 'fake-token');
  await settle();
  assert.equal(calls.context.get('decky-mcp.paired'), true);
  const roots = await deviceProvider().getChildren();
  assert.deepEqual(labels(roots), ['Devices', '10.1.2.3:8765', 'Screen', 'Actions']);
  assert.equal(roots[1].description, 'Connected · decky-mcp 0.2.0 · api 1');
  assert.equal(roots[2].description, '30 fps · 19.5 Mbps', 'stats polled because the Device view is visible');
  assert.equal(roots[2].command.command, 'decky-mcp.openScreen');
  const devs = await deviceProvider().getChildren(roots[0]);
  assert.equal(devs[0].contextValue, 'device.active');
  assert.equal(devs.at(-1).command.command, 'decky-mcp.addDevice');
  const conn = await deviceProvider().getChildren(roots[1]);
  assert.deepEqual(conn.map(c => c.command.command), ['decky-mcp.pair', 'decky-mcp.enterToken', 'decky-mcp.changeHost', 'decky-mcp.disconnect']);
  const actions = await deviceProvider().getChildren(roots[3]);
  assert.equal(actions.length, 8);
  for (const a of actions) assert.ok(calls.commands.has(a.command.command), a.command.command);
  const pl = await pluginsProvider().getChildren();
  assert.deepEqual(labels(pl), ['Decky-MCP', 'Tender']);
  assert.equal(pl[0].description, '0.1.0 · decky-mcp');
  assert.equal(pl[0].contextValue, 'plugin');
  assert.match(pl[0].tooltip.value, /flags: root, debug/);
  assert.match(pl[0].tooltip.value, /has_backend: true/);
  assert.match(calls.statusItems[0].text, /● 30 fps/);
  return `${labels(roots).join(' | ')}; screen "${roots[2].description}"; plugins ${labels(pl).join(', ')}`;
});

await check('stats polling stops when the Device view is hidden', async () => {
  const t = calls.treeViews.find(x => x.id === 'decky-mcp.device');
  t.view.visible = false;
  t.view._visibility.fire({ visible: false });
  await settle();
  const roots = await deviceProvider().getChildren();
  assert.equal(roots[2].description, '');
  t.view.visible = true;
  t.view._visibility.fire({ visible: true });
  await settle();
  assert.equal((await deviceProvider().getChildren())[2].description, '30 fps · 19.5 Mbps');
  return 'lease released on hide, re-acquired on show';
});

await check('fake client: plugin tree states', async () => {
  const fakeConn = (client, extra = {}) => ({
    devices: [], activeDevice: undefined, address: { host: 'h', port: 1 }, label: 'h', paired: !!client, tokenRejected: false,
    health: { kind: 'ok', health }, onDidChange: new EventEmitter().event, onDidChangeTarget: new EventEmitter().event,
    authedClient: () => client, watchStats: () => new Disposable(), ...extra,
  });
  const ok = new ext.PluginsTreeProvider(fakeConn({ listPlugins: async () => plugins }));
  assert.deepEqual(labels(await ok.getChildren()), ['Decky-MCP', 'Tender']);
  const empty = new ext.PluginsTreeProvider(fakeConn({ listPlugins: async () => [] }));
  assert.deepEqual(labels(await empty.getChildren()), ['No plugins installed']);
  const broken = new ext.PluginsTreeProvider(fakeConn({ listPlugins: async () => { throw new Error('boom'); } }));
  const [p] = await broken.getChildren();
  assert.match(p.label, /Could not load plugins: boom/);
  assert.equal(p.command.command, 'decky-mcp.refreshPlugins');
  const unpaired = new ext.PluginsTreeProvider(fakeConn(undefined));
  assert.deepEqual(await unpaired.getChildren(), []);
  const down = new ext.DeviceTreeProvider(fakeConn({}, { health: { kind: 'unreachable', error: 'cannot reach the device' } }));
  const roots = down.getChildren();
  assert.equal(roots[1].description, 'Unreachable');
  assert.equal(roots[2].description, 'offline');
  return 'list / empty / error placeholder / unpaired / unreachable';
});

await check('preview webview: CSP and proxy URL, no token', async () => {
  const { provider } = calls.webviewProviders[0];
  const messages = new EventEmitter();
  const webview = { options: {}, html: '', cspSource: 'vscode-resource:', asWebviewUri: u => u, postMessage: async () => true, onDidReceiveMessage: messages.event };
  const view = { webview, visible: true, onDidChangeVisibility: new EventEmitter().event, onDidDispose: () => new Disposable() };
  await provider.resolveWebviewView(view);
  assert.match(webview.html, /default-src 'none'/);
  assert.match(webview.html, /img-src http:\/\/127\.0\.0\.1:\d+ blob:/);
  assert.match(webview.html, /Open full screen view/);
  assert.ok(!webview.html.includes('fake-token'));
  assert.equal(webview.options.enableScripts, true);
  return 'ok';
});

await check('disconnect returns to the not-paired state', async () => {
  await calls.commands.get('decky-mcp.disconnect')();
  await settle();
  assert.deepEqual(await deviceProvider().getChildren(), []);
  assert.equal(calls.context.get('decky-mcp.paired'), false);
});

for (const d of ctx.subscriptions) d.dispose?.();
ext.deactivate();
const failed = results.filter(r => !r).length;
console.log(failed ? `\n${failed} check(s) failed` : `\nall ${results.length} smoke checks passed`);
process.exit(failed ? 1 : 0);
