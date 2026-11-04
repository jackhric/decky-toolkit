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
    contents: "export * from './src/extension'; export * from './src/actionsTree'; export * from './src/pluginsTree';",
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

const calls = {
  treeViews: [], treeProviders: [], webviewProviders: [], commands: new Map(), context: new Map(), statusItems: [],
  panels: [], progress: [], messages: [], statusMessages: [], clipboard: [], unexpectedErrors: [], opened: [], written: [], saveDialogs: [],
};

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
class ThemeIcon { constructor(id, color) { this.id = id; this.color = color; } }
class ThemeColor { constructor(id) { this.id = id; } }
class MarkdownString { value = ''; appendMarkdown(s) { this.value += s; return this; } }
const Uri = {
  parse: s => ({ toString: () => s, path: new URL(s).pathname }),
  file: p => ({ toString: () => `file://${p}`, path: p, fsPath: p }),
  joinPath: (u, ...p) => ({ toString: () => [u.toString(), ...p].join('/'), path: [u.path ?? '', ...p].join('/') }),
};
const files = new Map();

// UI answers, replaced per check. Every message is logged; an unexpected error message fails the run.
const ui = {};
const resetUi = () => Object.assign(ui, {
  error: m => { calls.unexpectedErrors.push(m); },
  warning: () => undefined, info: () => undefined, quickPick: () => undefined, inputBox: () => undefined, onProgress: () => undefined,
  saveDialog: () => undefined,
});
resetUi();
const say = kind => async (m, ...rest) => {
  const buttons = rest.filter(r => typeof r === 'string');
  calls.messages.push({ kind, m, buttons });
  return ui[kind](m, buttons);
};

const settings = { host: '10.1.2.3', port: 8765, pluginDirName: '' };
const configEmitter = new EventEmitter();
const noop = async () => undefined;
const noopEvent = () => new Disposable();
const vscode = {
  EventEmitter, Disposable, TreeItem, ThemeIcon, ThemeColor, MarkdownString, Uri,
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
      const view = { id, visible: true, title: undefined, description: undefined, onDidChangeVisibility: visibility.event, dispose() {}, _visibility: visibility };
      calls.treeViews.push({ id, provider: opts.treeDataProvider, view });
      return view;
    },
    createWebviewPanel: (viewType, title) => {
      const dispose = new EventEmitter();
      const received = new EventEmitter();
      const posted = [];
      const panel = {
        viewType, title, reveal() {}, dispose: () => dispose.fire(),
        onDidDispose: dispose.event, onDidChangeViewState: new EventEmitter().event,
        webview: { html: '', cspSource: 'vscode-resource:', asWebviewUri: u => u, postMessage: async m => { posted.push(m); return true; }, onDidReceiveMessage: received.event },
        _received: received, _posted: posted,
      };
      calls.panels.push(panel);
      return panel;
    },
    registerTreeDataProvider: (id, provider) => { calls.treeProviders.push({ id, provider }); return new Disposable(); },
    registerWebviewViewProvider: (id, provider) => { calls.webviewProviders.push({ id, provider }); return new Disposable(); },
    showErrorMessage: say('error'),
    showWarningMessage: say('warning'),
    showInformationMessage: say('info'),
    showInputBox: async opts => ui.inputBox(opts),
    showQuickPick: async (items, opts) => ui.quickPick(await items, opts),
    showOpenDialog: noop,
    showSaveDialog: async opts => { calls.saveDialogs.push(opts); return ui.saveDialog(opts); },
    setStatusBarMessage: m => { calls.statusMessages.push(m); return new Disposable(); },
    withProgress: (o, fn) => {
      const entry = { title: o.title, messages: [] };
      calls.progress.push(entry);
      const cancel = new EventEmitter();
      return fn(
        { report: m => { entry.messages.push(m.message); if (entry.messages.length === 1) ui.onProgress(entry); } },
        { isCancellationRequested: false, onCancellationRequested: cancel.event },
      );
    },
  },
  commands: {
    registerCommand: (id, fn) => { calls.commands.set(id, fn); return new Disposable(() => calls.commands.delete(id)); },
    executeCommand: async (id, ...args) => {
      if (id === 'setContext') { calls.context.set(args[0], args[1]); return; }
      return calls.commands.get(id)?.(...args);
    },
  },
  workspace: {
    getConfiguration: () => ({
      get: (k, d) => settings[k] ?? d,
      inspect: () => ({}),
      update: async (k, v) => {
        settings[k] = v;
        configEmitter.fire({ affectsConfiguration: s => s === `decky-mcp.${k}` || s === 'decky-mcp' });
      },
    }),
    onDidChangeConfiguration: configEmitter.event,
    onDidChangeWorkspaceFolders: new EventEmitter().event,
    createFileSystemWatcher: () => ({ onDidCreate: noopEvent, onDidDelete: noopEvent, onDidChange: noopEvent, dispose() {} }),
    workspaceFolders: undefined,
    fs: {
      readFile: async u => { if (files.has(u.toString())) return files.get(u.toString()); throw new vscode.FileSystemError('nope'); },
      writeFile: async (u, data) => { calls.written.push({ uri: u.toString(), data }); },
    },
    asRelativePath: p => String(p),
  },
  env: { asExternalUri: async u => u, openExternal: async u => { calls.opened.push(u.toString()); return true; }, clipboard: { writeText: async t => { calls.clipboard.push(t); } } },
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

// Fake device behind global fetch so the real DeckyClient is exercised. 10.9.9.9 never answers.
const health = { ok: true, name: 'decky-mcp', version: '0.2.0', api_version: 1, tools: 15 };
const stats = { available: true, running: true, subscribers: 1, fps: 30, kbps: 19542, frames_total: 10, uptime_s: 1, width: 1920, height: 1080, settings: { fps: 30, quality: 70, width: 0 }, error: null };
const plugins = [
  { dir: 'decky-mcp', name: 'Decky-MCP', author: 'jackh', flags: ['root', 'debug'], api_version: 1, version: '0.1.0', has_backend: true },
  { dir: 'romm-tender', name: 'Tender', author: 'x', flags: [], api_version: 1, version: '0.33.0', has_backend: true },
];
const device = { up: true, pairQueue: [], inputSupported: true, input: { enabled: false, backend: 'ei', available: true, reason: null } };
const frameJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
const fetched = [];
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  const auth = new Headers(init.headers).get('authorization');
  if (!device.up || u.hostname === '10.9.9.9') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' } });
  fetched.push(u.pathname);
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (u.pathname === '/health') return json(health);
  if (u.pathname === '/pair') {
    return device.pairQueue.shift() === 'grant'
      ? json({ token: 'fake-token', url: `http://${u.host}/viewer`, api_version: 1 })
      : json({ error: 'no pairing window open' }, 403);
  }
  if (auth !== 'Bearer fake-token') return new Response('unauthorized', { status: 401 });
  if (u.pathname === '/stream/stats') return json(stats);
  if (u.pathname === '/plugins') return json(plugins);
  if (u.pathname === '/input/settings') {
    if (!device.inputSupported) return new Response('404: Not Found', { status: 404 });
    if (init.method === 'PUT') device.input = { ...device.input, enabled: JSON.parse(init.body).enabled };
    return json(device.input);
  }
  if (u.pathname === '/frame.jpg') return new Response(frameJpeg, { headers: { 'content-type': 'image/jpeg' } });
  const reload = /^\/plugins\/([^/]+)\/reload$/.exec(u.pathname);
  if (reload && init.method === 'POST') return json({ ok: true, dir: decodeURIComponent(reload[1]) });
  return new Response('not found', { status: 404 });
};

// Minimal when-clause evaluator: ==, !=, =~ /re/, !, &&, ||, parentheses (&& binds tighter).
function evalWhen(expr, context) {
  if (!expr) return true;
  const toks = expr.match(/==|!=|=~|&&|\|\||!|\(|\)|\/(?:\\.|[^/])+\/|[A-Za-z0-9_.\-]+/g);
  let i = 0;
  const peek = () => toks[i], next = () => toks[i++];
  const or = () => { let v = and(); while (peek() === '||') { next(); const r = and(); v = v || r; } return v; };
  const and = () => { let v = not(); while (peek() === '&&') { next(); const r = not(); v = v && r; } return v; };
  const not = () => (peek() === '!' ? (next(), !not()) : prim());
  const prim = () => {
    if (peek() === '(') { next(); const v = or(); assert.equal(next(), ')', expr); return v; }
    const key = next();
    if (key === 'true') return true;
    if (key === 'false') return false;
    const val = context.get(key);
    if (peek() === '==') { next(); return String(val) === next(); }
    if (peek() === '!=') { next(); return String(val) !== next(); }
    if (peek() === '=~') { next(); return new RegExp(next().slice(1, -1)).test(String(val ?? '')); }
    return !!val;
  };
  const v = or();
  assert.equal(i, toks.length, `could not parse when clause: ${expr}`);
  return v;
}
const visibleViews = (context = calls.context) => pkg.contributes.views['decky-mcp'].filter(v => evalWhen(v.when, context)).map(v => v.id);
const itemMenu = (view, viewItem, inline) => pkg.contributes.menus['view/item/context']
  .filter(m => (m.group ?? '').startsWith('inline') === inline)
  .filter(m => evalWhen(m.when, new Map([...calls.context, ['view', view], ['viewItem', viewItem]])))
  .map(m => m.command);

const results = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    results.push(true);
    console.log(`PASS  ${name}${detail ? `: ${detail}` : ''}`);
  } catch (e) {
    results.push(false);
    console.log(`FAIL  ${name}: ${e.stack ?? e}`);
  } finally {
    resetUi();
  }
}
const settle = (ms = 50) => new Promise(r => setTimeout(r, ms));
const labels = items => items.map(i => i.label);
const run = (id, ...args) => calls.commands.get(id)(...args);
const tokenKey = 'decky-mcp.token:10.1.2.3:8765';
const lastMessage = kind => calls.messages.filter(m => m.kind === kind).at(-1);

ext.connectionTimings.healthPollMs = 40;
ext.pairingTimings.pollMs = 20;

await ext.activate(ctx);
await settle();

const tree = id => calls.treeViews.find(t => t.id === id);
const actionsProvider = () => tree('decky-mcp.actions').provider;
const pluginsProvider = () => tree('decky-mcp.plugins').provider;
const devicesProvider = () => tree('decky-mcp.devices').provider;
const status = () => calls.statusItems[0].text;
const seedId = () => globalState.get('decky-mcp.devices')[0].id;
const titleMenu = view => pkg.contributes.menus['view/title'].filter(m => evalWhen(m.when, new Map([...calls.context, ['view', view]]))).map(m => m.command);
const dupes = list => list.filter((x, i) => list.indexOf(x) !== i);

const EXPECTED_ACTIONS = {
  Screen: ['device-desktop', 2, [
    ['Open screen panel', 'decky-mcp.openScreen'], ['Open viewer in browser', 'decky-mcp.openViewer'], ['Snapshot to file', 'decky-mcp.snapshot']]],
  Plugin: ['package', 2, [
    ['Deploy', 'decky-mcp.deploy'], ['Reload backend', 'decky-mcp.reloadPlugin'], ['Show plugin logs', 'decky-mcp.pluginLogs']]],
  Loader: ['server', 2, [
    ['Restart loader', 'decky-mcp.restartLoader'], ['Show loader logs', 'decky-mcp.loaderLogs'], ['Install plugin zip…', 'decky-mcp.installZip']]],
  Steam: ['game', 1, [['Evaluate JS in Steam UI', 'decky-mcp.evaluate'], ['Toast on Deck', 'decky-mcp.toast']]],
  MCP: ['server-process', 1, [
    ['Write MCP config for this workspace', 'decky-mcp.writeMcpConfig'], ['Copy MCP URL', 'decky-mcp.copyMcpUrl'], ['Copy token', 'decky-mcp.copyToken']]],
};

/** Asserts the Actions tree shape and returns { roots, kids: { Screen: [...], ... } }. */
async function actionsTree() {
  const p = actionsProvider();
  const roots = await p.getChildren();
  assert.deepEqual(labels(roots), Object.keys(EXPECTED_ACTIONS));
  const kids = {};
  for (const r of roots) {
    const [icon, state, leaves] = EXPECTED_ACTIONS[r.label];
    assert.equal(r.iconPath.id, icon, r.label);
    assert.equal(r.collapsibleState, state, `${r.label} collapsible state`);
    assert.equal(r.command, undefined, `${r.label} group toggles instead of running a command`);
    const children = await p.getChildren(r);
    assert.deepEqual(children.map(c => [c.label, c.command.command]), leaves, r.label);
    for (const c of children) {
      assert.ok(c.iconPath.id, `${c.label} has an icon`);
      assert.equal(c.collapsibleState, 0, `${c.label} is a single-click leaf`);
      assert.ok(calls.commands.has(c.command.command), c.command.command);
    }
    kids[r.label] = children;
  }
  const leafCmds = Object.values(kids).flat().map(c => c.command.command);
  assert.deepEqual(dupes(leafCmds), [], 'a command appears twice in the Actions tree');
  for (const bad of ['decky-mcp.connect', 'decky-mcp.disconnectDevice', 'decky-mcp.pairAgain', 'decky-mcp.enterToken', 'decky-mcp.disconnect']) {
    assert.ok(!leafCmds.includes(bad), `${bad} in the Actions view`);
  }
  return { roots, kids };
}

await check('activate() registers the four views', async () => {
  const trees = [...calls.treeViews.map(t => t.id), ...calls.treeProviders.map(t => t.id)].sort();
  assert.deepEqual(trees, ['decky-mcp.actions', 'decky-mcp.devices', 'decky-mcp.plugins']);
  assert.deepEqual(calls.webviewProviders.map(w => w.id), ['decky-mcp.preview']);
  const declared = pkg.contributes.views['decky-mcp'].map(v => [v.id, v.name]);
  assert.deepEqual(declared, [
    ['decky-mcp.devices', 'Devices'], ['decky-mcp.actions', 'Actions'], ['decky-mcp.plugins', 'Plugins'], ['decky-mcp.preview', 'Preview']]);
  return `createTreeView(${trees.join(', ')}), registerWebviewViewProvider(decky-mcp.preview)`;
});

await check('package.json: container, activation, commands, menus, version', async () => {
  assert.equal(pkg.version, '0.4.0');
  const container = pkg.contributes.viewsContainers.activitybar[0];
  assert.equal(container.id, 'decky-mcp');
  assert.equal(container.title, 'Decky');
  assert.equal(readFileSync(path.join(root, container.icon), 'utf8').includes('currentColor'), true);
  for (const v of pkg.contributes.views['decky-mcp']) assert.ok(pkg.activationEvents.includes(`onView:${v.id}`), v.id);
  assert.equal(pkg.activationEvents.length, 5);
  assert.ok(pkg.activationEvents.includes('workspaceContains:plugin.json'));
  for (const v of pkg.contributes.views['decky-mcp']) {
    assert.ok(v.id === 'decky-mcp.devices' ? v.when === undefined : v.when === 'decky-mcp.connected', `${v.id} when: ${v.when}`);
  }
  const declared = new Set(pkg.contributes.commands.map(c => c.command));
  const registered = new Set(calls.commands.keys());
  for (const id of declared) assert.ok(registered.has(id), `declared but not registered: ${id}`);
  for (const id of registered) assert.ok(declared.has(id), `registered but not declared: ${id}`);
  const menus = Object.values(pkg.contributes.menus).flat();
  for (const m of menus) assert.ok(declared.has(m.command), `menu refers to unknown command ${m.command}`);
  for (const m of menus) evalWhen(m.when, new Map());
  const whens = [...menus.map(m => m.when), ...pkg.contributes.views['decky-mcp'].map(v => v.when), ...pkg.contributes.viewsWelcome.map(w => w.when)];
  const allowedKeys = new Set(['view', 'viewItem', 'decky-mcp.connected', 'false']);
  for (const w of whens.filter(Boolean)) {
    for (const [, key] of w.replace(/\/(?:\\.|[^/])+\//g, '/re/').matchAll(/(?:^|&&|\|\||\(|!)\s*([A-Za-z][\w.-]*)/g)) assert.ok(allowedKeys.has(key), `context key ${key} in ${w}`);
  }
  assert.deepEqual(pkg.contributes.viewsWelcome.map(w => w.view), ['decky-mcp.devices']);
  assert.deepEqual(Object.keys(pkg.contributes.configuration.properties).sort(),
    ['decky-mcp.host', 'decky-mcp.openScreenOnConnect', 'decky-mcp.pluginDirName', 'decky-mcp.port']);
  assert.equal(pkg.contributes.configuration.properties['decky-mcp.openScreenOnConnect'].default, true);
  const titles = {
    'decky-mcp.devices': ['decky-mcp.addDevice', 'decky-mcp.refresh'],
    'decky-mcp.actions': ['decky-mcp.openScreen', 'decky-mcp.refresh'],
    'decky-mcp.plugins': ['decky-mcp.installZip', 'decky-mcp.refreshPlugins'],
    'decky-mcp.preview': ['decky-mcp.openScreen'],
  };
  for (const [view, want] of Object.entries(titles)) assert.deepEqual(titleMenu(view), want, `${view} title`);
  for (const view of Object.keys(titles)) {
    for (const viewItem of ['plugin', 'deck.unpaired', 'deck.paired', 'deck.session', 'deck.busy', 'action', 'group.screen']) {
      for (const inline of [true, false]) assert.deepEqual(dupes(itemMenu(view, viewItem, inline)), [], `${view} ${viewItem}`);
    }
  }
  assert.deepEqual(visibleViews(new Map()), ['decky-mcp.devices'], 'before activation only Devices shows');
  return `${declared.size} commands registered, ${menus.length} menu entries resolve, titles ${Object.values(titles).map(t => t.length).join('/')}`;
});

await check('first activation seeds one saved device from the settings', async () => {
  const list = globalState.get('decky-mcp.devices');
  assert.equal(list.length, 1);
  assert.equal(list[0].host, '10.1.2.3');
  assert.equal(globalState.get('decky-mcp.activeDevice'), list[0].id);
  return JSON.stringify({ name: list[0].name, host: list[0].host, port: list[0].port });
});

await check('unpaired: only Devices visible, one row, Connect inline', async () => {
  assert.equal(calls.context.get('decky-mcp.connected'), false);
  assert.deepEqual([...calls.context.keys()], ['decky-mcp.connected'], 'the only context key');
  assert.deepEqual(visibleViews(), ['decky-mcp.devices']);
  const rows = devicesProvider().getChildren();
  assert.equal(rows.length, 1);
  const [r] = rows;
  assert.equal(r.label, '10.1.2.3', 'name equal to host is shown once');
  assert.equal(r.description, 'not paired');
  assert.equal(r.iconPath.id, 'key');
  assert.equal(r.contextValue, 'deck.unpaired');
  assert.deepEqual(r.command, { command: 'decky-mcp.connect', title: 'Connect', arguments: [seedId()] });
  assert.deepEqual(itemMenu('decky-mcp.devices', r.contextValue, true), ['decky-mcp.connect', 'decky-mcp.deviceActions']);
  assert.ok(!itemMenu('decky-mcp.devices', r.contextValue, false).includes('decky-mcp.pairAgain'));
  assert.deepEqual(await actionsProvider().getChildren(), []);
  assert.deepEqual(await pluginsProvider().getChildren(), []);
  assert.equal(status(), '$(vm) Decky: not connected');
  return `row "${r.label}" — "${r.description}" [$(${r.iconPath.id})], inline ${itemMenu('decky-mcp.devices', r.contextValue, true).join(', ')}; status "${status()}"`;
});

await check('fake client: plugin tree states, Actions Screen offline when unreachable', async () => {
  const fakeConn = (client, extra = {}) => ({
    devices: [], activeDevice: undefined, address: { host: 'h', port: 1 }, label: 'h', paired: !!client, tokenRejected: false,
    connectedDevice: client ? { id: 'x', name: 'h', host: 'h', port: 1 } : undefined,
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
  const down = new ext.ActionsTreeProvider(fakeConn({}, { health: { kind: 'unreachable', error: 'cannot reach the device' } }));
  const roots = await down.getChildren();
  assert.equal(roots[0].description, 'offline');
  down.dispose();
  return 'list / empty / error placeholder / not connected / unreachable';
});

await check('preview webview: CSP and proxy URL, no token', async () => {
  const { provider } = calls.webviewProviders[0];
  const messages = new EventEmitter();
  const webview = { options: {}, html: '', cspSource: 'vscode-resource:', asWebviewUri: u => u, postMessage: async () => true, onDidReceiveMessage: messages.event };
  const view = { webview, visible: true, onDidChangeVisibility: new EventEmitter().event, onDidDispose: () => new Disposable() };
  await provider.resolveWebviewView(view);
  calls.previewView = view;
  assert.match(webview.html, /default-src 'none'/);
  assert.match(webview.html, /img-src http:\/\/127\.0\.0\.1:\d+ blob:/);
  assert.match(webview.html, /Open full screen view/);
  assert.ok(!webview.html.includes('fake-token'));
  assert.equal(webview.options.enableScripts, true);
  return 'ok';
});

await check('Connect on an unpaired device pairs (403, then token) and connects', async () => {
  fetched.length = 0;
  device.pairQueue = ['closed', 'grant'];
  let rowDuringPairing;
  ui.onProgress = () => { rowDuringPairing = devicesProvider().getChildren()[0]; };
  await run('decky-mcp.connect', seedId());
  await settle();
  assert.deepEqual(fetched.filter(p => p === '/pair').length, 2, 'polled /pair twice');
  assert.ok(!fetched.slice(0, fetched.indexOf('/pair')).includes('/stream/stats'), 'no token, so no token check before pairing');
  const prog = calls.progress.at(-1);
  assert.equal(prog.title, 'Pairing with 10.1.2.3');
  assert.match(prog.messages[0], /^on the Deck open Quick Access → Decky-MCP → Pair a browser\. Waiting… \d+ s$/);
  assert.equal(rowDuringPairing.description, 'pairing…');
  assert.equal(rowDuringPairing.contextValue, 'deck.busy');
  assert.equal(secrets.get(tokenKey), 'fake-token');
  assert.equal(calls.context.get('decky-mcp.connected'), true);
  const info = lastMessage('info');
  assert.equal(info.m, 'Decky-MCP: Paired with 10.1.2.3.');
  assert.deepEqual(info.buttons, ['Open screen', 'Deploy plugin']);
  assert.equal(calls.panels.length, 1, 'openScreenOnConnect opened the screen panel');
  assert.equal(calls.messages.filter(m => m.kind === 'warning' || m.kind === 'error').length, 0, 'no extra prompts');
  return `progress "${prog.title}: ${prog.messages[0]}", then "${info.m}" [${info.buttons.join(', ')}], screen panel opened`;
});

await check('connected: views, device row, titles and status bar', async () => {
  await settle(100);
  assert.deepEqual(visibleViews(), ['decky-mcp.devices', 'decky-mcp.actions', 'decky-mcp.plugins', 'decky-mcp.preview']);
  const [r] = devicesProvider().getChildren();
  assert.equal(r.label, '10.1.2.3');
  assert.equal(r.description, 'connected');
  assert.equal(r.iconPath.id, 'vm-connect');
  assert.equal(r.iconPath.color.id, 'testing.iconPassed');
  assert.equal(r.contextValue, 'deck.session');
  assert.equal(r.command, undefined);
  assert.deepEqual(itemMenu('decky-mcp.devices', r.contextValue, true), ['decky-mcp.disconnectDevice', 'decky-mcp.deviceActions']);
  const ctxMenu = itemMenu('decky-mcp.devices', r.contextValue, false);
  for (const bad of ['decky-mcp.connect', 'decky-mcp.pair']) assert.ok(!ctxMenu.includes(bad), `${bad} on a connected device`);
  assert.ok(ctxMenu.includes('decky-mcp.pairAgain'));
  assert.equal(pkg.contributes.commands.find(c => c.command === 'decky-mcp.pairAgain').title, 'Re-pair');
  assert.deepEqual(labels(await pluginsProvider().getChildren()), ['Decky-MCP', 'Tender']);
  assert.equal(tree('decky-mcp.actions').view.description, '10.1.2.3');
  assert.equal(tree('decky-mcp.plugins').view.description, '10.1.2.3');
  assert.equal(calls.previewView.description, '10.1.2.3');
  assert.equal(status(), '$(vm-connect) 10.1.2.3');
  return `row "${r.label}" — "${r.description}" [$(vm-connect) green], inline ${itemMenu('decky-mcp.devices', r.contextValue, true).join(', ')}; visible ${visibleViews().join(', ')}`;
});

await check('connected, no plugin.json: Actions roots Screen / Plugin / Loader / Steam / MCP with their leaves', async () => {
  const { roots, kids } = await actionsTree();
  const [screen, plugin] = roots;
  assert.equal(screen.description, '30 fps · 19.5 Mbps', 'stats polled because the Actions view is visible');
  assert.match(kids.Screen[1].tooltip, /http:\/\/10\.1\.2\.3:8765\/viewer/);
  assert.match(kids.Screen[1].tooltip, /Pair a browser/);
  assert.match(kids.Screen[1].tooltip, /cookie/);
  assert.equal(plugin.description, 'no plugin.json in workspace');
  for (const c of kids.Plugin) {
    assert.equal(c.description, 'needs a plugin folder');
    assert.equal(c.iconPath.color.id, 'disabledForeground');
  }
  const lines = roots.map(r => `${r.label}${r.description ? ` (${r.description})` : ''}: ${labels(kids[r.label]).join(', ')}`);
  return lines.join(' | ');
});

await check('Plugin group without plugin.json: clicks explain why, no request', async () => {
  for (const leaf of (await actionsProvider().getChildren((await actionsProvider().getChildren())[1]))) {
    fetched.length = 0;
    calls.messages.length = 0;
    await run(leaf.command.command, ...(leaf.command.arguments ?? []));
    const w = lastMessage('warning');
    assert.ok(w, `${leaf.label} explained nothing`);
    assert.match(w.m, /no workspace folder contains a plugin\.json/);
    assert.ok(!fetched.some(p => p.startsWith('/plugins/')), `${leaf.label} hit the device`);
  }
  return lastMessage('warning').m;
});

await check('Plugin group with a plugin folder: description is the deploy dir, reload/logs target it', async () => {
  const folderPath = '/work/my-plugin';
  vscode.workspace.workspaceFolders = [{ name: 'my-plugin', uri: Uri.file(folderPath) }];
  files.set(`file://${folderPath}/plugin.json`, Buffer.from(JSON.stringify({ name: 'My Plugin' })));
  actionsProvider().refresh();
  try {
    const { roots, kids } = await actionsTree();
    assert.equal(roots[1].description, 'my-plugin');
    assert.match(roots[1].tooltip, /~\/homebrew\/plugins\/my-plugin/);
    for (const c of kids.Plugin) assert.equal(c.description, undefined);
    fetched.length = 0;
    const reload = kids.Plugin[1];
    await run(reload.command.command, ...reload.command.arguments);
    assert.ok(fetched.includes('/plugins/my-plugin/reload'), fetched.join(', '));
    assert.equal(lastMessage('info').m, 'Decky-MCP: reloaded my-plugin.');
    settings.pluginDirName = 'other-dir';
    actionsProvider().refresh();
    assert.equal((await actionsProvider().getChildren())[1].description, 'other-dir', 'decky-mcp.pluginDirName wins');
    return `Plugin (${roots[1].description}), reload → POST /plugins/my-plugin/reload`;
  } finally {
    settings.pluginDirName = '';
    vscode.workspace.workspaceFolders = undefined;
    files.clear();
    actionsProvider().refresh();
  }
});

await check('Screen and MCP leaves: viewer, snapshot, MCP URL, token', async () => {
  await run('decky-mcp.openViewer');
  assert.equal(calls.opened.at(-1), 'http://10.1.2.3:8765/viewer');
  ui.saveDialog = opts => opts.defaultUri;
  await run('decky-mcp.snapshot');
  const dlg = calls.saveDialogs.at(-1);
  assert.match(dlg.defaultUri.toString(), /\/deck-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.jpg$/);
  const w = calls.written.at(-1);
  assert.equal(w.uri, dlg.defaultUri.toString());
  assert.deepEqual([...w.data], [...frameJpeg]);
  assert.match(lastMessage('info').m, /saved .*deck-.*\.jpg/);
  await run('decky-mcp.copyMcpUrl');
  assert.equal(calls.clipboard.at(-1), 'http://10.1.2.3:8765/mcp');
  await run('decky-mcp.copyToken');
  assert.equal(calls.clipboard.at(-1), 'fake-token');
  assert.match(lastMessage('warning').m, /secret/);
  return `opened ${calls.opened.at(-1)}; snapshot → ${dlg.defaultUri.path.split('/').pop()} (${w.data.length} B); token warning "${lastMessage('warning').m}"`;
});

await check('remote input: screen panel toggle, toggle command, status bar, unavailable / unsupported', async () => {
  const panel = calls.panels[0];
  const lastState = () => panel._posted.filter(m => m.type === 'input').at(-1)?.state;
  assert.match(panel.webview.html, /connect-src http:\/\/127\.0\.0\.1:(\d+) ws:\/\/127\.0\.0\.1:\1;/);
  assert.match(panel.webview.html, /<button id="inp"[^>]*>Input<\/button>/);
  assert.match(panel.webview.html, /<span class="seg" id="mode" hidden>/);
  assert.equal(pkg.contributes.commands.find(c => c.command === 'decky-mcp.toggleInput').title, 'Toggle remote input');
  assert.ok(!(await actionsTree()).kids.Screen.some(c => /input/i.test(c.label)), 'no input leaf in the Actions view');

  panel._posted.length = 0;
  panel._received.fire({ type: 'ready' });
  await settle();
  assert.deepEqual(lastState(), { supported: true, enabled: false, available: true, backend: 'libei', reason: null });
  assert.equal(status(), '$(vm-connect) 10.1.2.3');

  // The panel's Input button goes through the extension, which answers with the new state.
  fetched.length = 0;
  panel._received.fire({ type: 'setInput', enabled: true });
  await settle();
  assert.deepEqual(fetched.filter(f => f === '/input/settings').length, 2, 'GET then PUT');
  assert.equal(device.input.enabled, true);
  assert.equal(lastState().enabled, true);
  assert.equal(status(), '$(vm-connect) 10.1.2.3 $(keyboard)');
  assert.match(calls.statusItems[0].tooltip, /remote input on/);
  assert.match(calls.statusMessages.at(-1), /remote input on \(libei\)/);

  await run('decky-mcp.toggleInput');
  await settle();
  assert.equal(device.input.enabled, false);
  assert.equal(lastState().enabled, false, 'the panel follows a toggle from the palette');
  assert.equal(status(), '$(vm-connect) 10.1.2.3');

  device.input = { enabled: false, backend: null, available: false, reason: 'no libei socket and /dev/uinput is not writable' };
  panel._received.fire({ type: 'setInput', enabled: true });
  await settle();
  assert.match(lastMessage('warning').m, /remote input is unavailable on 10\.1\.2\.3: no libei socket/);
  assert.equal(device.input.enabled, false, 'nothing PUT while unavailable');
  assert.deepEqual(lastState(), { supported: true, enabled: false, available: false, backend: '', reason: device.input.reason });

  device.inputSupported = false;
  await run('decky-mcp.toggleInput');
  assert.match(lastMessage('warning').m, /not supported by this device version/);
  await settle();
  assert.deepEqual(lastState(), { supported: false, enabled: false, available: false, backend: null, reason: 'not supported by this device version' });

  device.inputSupported = true;
  device.input = { enabled: false, backend: 'ei', available: true, reason: null };
  await run('decky-mcp.refresh');
  await settle(100);
  assert.equal(lastState().available, true);
  return 'panel Input on → $(keyboard) in status bar → palette toggle off → unavailable warning → 404 → "not supported by this device version"';
});

await check('stats polling stops when the Actions view is hidden', async () => {
  calls.panels[0].dispose();
  const t = tree('decky-mcp.actions');
  t.view.visible = false;
  t.view._visibility.fire({ visible: false });
  await settle();
  assert.equal((await actionsProvider().getChildren())[0].description, '');
  t.view.visible = true;
  t.view._visibility.fire({ visible: true });
  await settle();
  assert.equal((await actionsProvider().getChildren())[0].description, '30 fps · 19.5 Mbps');
  return 'lease released on hide, re-acquired on show';
});

await check('connected: periodic /health flips to unreachable and back, token kept', async () => {
  device.up = false;
  await settle(150);
  let [r] = devicesProvider().getChildren();
  assert.equal(r.description, 'unreachable');
  assert.equal(r.iconPath.id, 'warning');
  assert.equal(calls.context.get('decky-mcp.connected'), true, 'views stay while the session is unreachable');
  assert.equal(tree('decky-mcp.actions').view.description, '10.1.2.3 · unreachable');
  assert.equal((await actionsProvider().getChildren())[0].description, 'offline');
  assert.equal(status(), '$(warning) 10.1.2.3 (unreachable)');
  assert.equal(secrets.get(tokenKey), 'fake-token');
  device.up = true;
  await settle(150);
  [r] = devicesProvider().getChildren();
  assert.equal(r.description, 'connected');
  assert.equal(status(), '$(vm-connect) 10.1.2.3');
  return 'connected → unreachable → connected';
});

await check('paired but disconnected: Disconnect keeps the token, hides Actions / Plugins / Preview', async () => {
  await run('decky-mcp.disconnectDevice');
  await settle();
  assert.equal(calls.context.get('decky-mcp.connected'), false);
  assert.deepEqual(visibleViews(), ['decky-mcp.devices']);
  const [r] = devicesProvider().getChildren();
  assert.equal(r.description, 'paired');
  assert.equal(r.iconPath.id, 'vm');
  assert.equal(r.contextValue, 'deck.paired');
  assert.equal(r.command.command, 'decky-mcp.connect');
  assert.deepEqual(itemMenu('decky-mcp.devices', r.contextValue, true), ['decky-mcp.connect', 'decky-mcp.deviceActions']);
  assert.deepEqual(await actionsProvider().getChildren(), []);
  assert.equal(secrets.get(tokenKey), 'fake-token');
  assert.equal(status(), '$(vm) Decky: not connected');
  return `row "${r.label}" — "${r.description}" [$(vm)]`;
});

await check('Connect with a stored token checks /health and connects without pairing', async () => {
  fetched.length = 0;
  await run('decky-mcp.connect', seedId());
  await settle();
  assert.ok(fetched.includes('/health'));
  assert.ok(!fetched.includes('/pair'));
  assert.equal(calls.context.get('decky-mcp.connected'), true);
  assert.match(calls.statusMessages.at(-1), /Connected to 10\.1\.2\.3/);
  assert.equal(calls.panels.length, 1, 'screen opens only after the first connect of a session');
  await run('decky-mcp.disconnectDevice');
  return `requests: ${[...new Set(fetched)].join(', ')}`;
});

await check('a rejected token (401) goes straight into pairing', async () => {
  await ctx.secrets.store(tokenKey, 'stale-token');
  await settle();
  fetched.length = 0;
  device.pairQueue = ['grant'];
  await run('decky-mcp.connect', seedId());
  await settle();
  assert.ok(fetched.includes('/pair'));
  assert.equal(secrets.get(tokenKey), 'fake-token');
  assert.equal(calls.context.get('decky-mcp.connected'), true);
  await run('decky-mcp.disconnectDevice');
  return `requests: ${fetched.join(', ')}`;
});

await check('a command while disconnected offers to connect instead of running', async () => {
  let offered;
  ui.warning = (m, buttons) => { offered = { m, buttons }; return undefined; };
  const copied = calls.clipboard.length;
  await run('decky-mcp.copyToken');
  assert.equal(offered.m, 'Decky-MCP: not connected to a Deck.');
  assert.deepEqual(offered.buttons, ['Connect to 10.1.2.3', 'Choose device']);
  assert.equal(calls.clipboard.length, copied, 'nothing copied');
  return `"${offered.m}" [${offered.buttons.join(', ')}]`;
});

await check('reachability error: one message with Retry / Edit device, no pairing; Retry connects', async () => {
  device.up = false;
  fetched.length = 0;
  let row;
  ui.error = (m, buttons) => {
    row = devicesProvider().getChildren()[0];
    calls.lastError = { m, buttons };
    device.up = true;
    return 'Retry';
  };
  await run('decky-mcp.connect', seedId());
  await settle();
  assert.equal(calls.lastError.m, "Can't reach 10.1.2.3 at 10.1.2.3:8765. Is the Deck on and Decky-MCP enabled?");
  assert.deepEqual(calls.lastError.buttons, ['Retry', 'Edit device']);
  assert.equal(row.description, 'unreachable');
  assert.equal(row.iconPath.id, 'warning');
  assert.equal(row.iconPath.color.id, 'problemsWarningIcon.foreground');
  assert.ok(!fetched.includes('/pair'));
  assert.equal(calls.context.get('decky-mcp.connected'), true, 'Retry connected once the Deck answered');
  await run('decky-mcp.disconnectDevice');
  return `"${calls.lastError.m}" [${calls.lastError.buttons.join(', ')}], row was "${row.description}"`;
});

await check('pairing timeout (short injected timeout): Try again / Enter token manually', async () => {
  await ctx.secrets.delete(tokenKey);
  await settle();
  ext.pairingTimings.timeoutMs = 200;
  device.pairQueue = [];
  const start = Date.now();
  await run('decky-mcp.connect', seedId());
  const took = Date.now() - start;
  ext.pairingTimings.timeoutMs = 120000;
  const w = lastMessage('warning');
  assert.match(w.m, /Pairing timed out/);
  assert.deepEqual(w.buttons, ['Try again', 'Enter token manually']);
  assert.equal(calls.context.get('decky-mcp.connected'), false);
  const [r] = devicesProvider().getChildren();
  assert.equal(r.description, 'not paired');
  return `"${w.m}" [${w.buttons.join(', ')}] after ${took} ms`;
});

await check('Add device: host + optional name, port only via "Change port", then offers Connect', async () => {
  const inputs = ['10.9.9.9', '', '9000'];
  const prompts = [];
  ui.inputBox = opts => { prompts.push(opts.prompt); if (opts.validateInput) assert.equal(opts.validateInput(inputs[0]), undefined); return inputs.shift(); };
  const picks = ['port', 'later'];
  const offered = [];
  ui.quickPick = items => { offered.push(items.map(i => i.label)); const want = picks.shift(); return items.find(i => i.id === want); };
  await run('decky-mcp.addDevice');
  await settle();
  const d = globalState.get('decky-mcp.devices')[1];
  assert.deepEqual({ name: d.name, host: d.host, port: d.port }, { name: '10.9.9.9', host: '10.9.9.9', port: 9000 });
  assert.equal(prompts.length, 3);
  assert.match(offered[0][0], /Connect to 10\.9\.9\.9/);
  assert.match(offered[0][1], /Change port \(8765\)/);
  ui.inputBox = opts => opts.validateInput('http://x/');
  await run('decky-mcp.refresh');
  await settle();
  const rows = devicesProvider().getChildren();
  assert.equal(rows[1].label, '10.9.9.9:9000');
  assert.equal(rows[1].description, 'unreachable', 'refresh probes saved devices');
  return `prompts: ${prompts.join(' / ')}; then picks ${offered[0].join(' | ')}`;
});

await check('status bar QuickPick: connect/switch, disconnect, open screen, add', async () => {
  await ctx.secrets.store(tokenKey, 'fake-token');
  await run('decky-mcp.connect', seedId());
  await settle();
  let offered;
  ui.quickPick = (items, opts) => { offered = { labels: items.map(i => i.label), placeHolder: opts.placeHolder }; return undefined; };
  await run('decky-mcp.switchDevice');
  assert.equal(calls.statusItems[0].command ?? 'decky-mcp.switchDevice', 'decky-mcp.switchDevice');
  assert.equal(offered.placeHolder, 'Connected to 10.1.2.3');
  assert.deepEqual(offered.labels, [
    '$(vm-connect) 10.1.2.3', '$(warning) 10.9.9.9', '', '$(debug-disconnect) Disconnect from 10.1.2.3', '$(device-desktop) Open screen', '$(add) Add device…']);
  assert.equal(calls.statusItems[0].tooltip, 'Decky: connected to 10.1.2.3 (10.1.2.3:8765). Click for devices');
  return offered.labels.filter(Boolean).join(' | ');
});

await check('Copy viewer URL and the … overflow menu', async () => {
  await run('decky-mcp.copyViewerUrl', seedId());
  assert.equal(calls.clipboard.at(-1), 'http://10.1.2.3:8765/viewer');
  let offered;
  ui.quickPick = items => { offered = items.map(i => i.label); };
  await run('decky-mcp.deviceActions', seedId());
  assert.deepEqual(offered.map(l => l.replace(/^\$\([^)]+\) /, '')), ['Re-pair', 'Enter token manually', 'Edit', 'Copy viewer URL', 'Remove']);
  return offered.join(' | ');
});

await check('no unexpected error messages', async () => {
  assert.deepEqual(calls.unexpectedErrors, []);
});

for (const d of ctx.subscriptions) d.dispose?.();
ext.deactivate();
const failed = results.filter(r => !r).length;
console.log(failed ? `\n${failed} check(s) failed` : `\nall ${results.length} smoke checks passed`);
process.exit(failed ? 1 : 0);
