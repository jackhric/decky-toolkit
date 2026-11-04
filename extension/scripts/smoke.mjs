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

const calls = {
  treeViews: [], treeProviders: [], webviewProviders: [], commands: new Map(), context: new Map(), statusItems: [],
  panels: [], progress: [], messages: [], statusMessages: [], clipboard: [], unexpectedErrors: [],
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
  joinPath: (u, ...p) => ({ toString: () => [u.toString(), ...p].join('/'), path: [u.path ?? '', ...p].join('/') }),
};

// UI answers, replaced per check. Every message is logged; an unexpected error message fails the run.
const ui = {};
const resetUi = () => Object.assign(ui, {
  error: m => { calls.unexpectedErrors.push(m); },
  warning: () => undefined, info: () => undefined, quickPick: () => undefined, inputBox: () => undefined, onProgress: () => undefined,
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
      const panel = {
        viewType, title, reveal() {}, dispose: () => dispose.fire(),
        onDidDispose: dispose.event, onDidChangeViewState: new EventEmitter().event,
        webview: { html: '', cspSource: 'vscode-resource:', asWebviewUri: u => u, postMessage: async () => true, onDidReceiveMessage: new EventEmitter().event },
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
    workspaceFolders: undefined,
    fs: { readFile: async () => { throw new vscode.FileSystemError('nope'); } },
    asRelativePath: p => String(p),
  },
  env: { asExternalUri: async u => u, openExternal: noop, clipboard: { writeText: async t => { calls.clipboard.push(t); } } },
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
const device = { up: true, pairQueue: [] };
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
const deviceProvider = () => tree('decky-mcp.device').provider;
const pluginsProvider = () => tree('decky-mcp.plugins').provider;
const devicesProvider = () => tree('decky-mcp.devices').provider;
const unifiedProvider = () => tree('decky-mcp.unified').provider;
const status = () => calls.statusItems[0].text;
const seedId = () => globalState.get('decky-mcp.devices')[0].id;

const fired = new Map();
for (const t of calls.treeViews) t.provider.onDidChangeTreeData(() => fired.set(t.id, (fired.get(t.id) ?? 0) + 1));
async function switchTo(layout) {
  fired.clear();
  const contextSets = [];
  ui.quickPick = items => { contextSets.push(items.map(i => i.id)); return items.find(i => i.id === layout); };
  await run('decky-mcp.switchLayout');
  await settle();
  assert.equal(settings.sidebarLayout, layout);
  assert.equal(calls.context.get('decky-mcp.layout'), layout);
  assert.deepEqual(contextSets[0], ['devices-first', 'unified', 'classic']);
  for (const t of calls.treeViews) assert.ok(fired.get(t.id) > 0, `${t.id} not refreshed`);
  return `setting=${layout}, context decky-mcp.layout=${layout}, refreshed ${[...fired.keys()].join(', ')}`;
}

await check('activate() registers the five views', async () => {
  const trees = [...calls.treeViews.map(t => t.id), ...calls.treeProviders.map(t => t.id)].sort();
  assert.deepEqual(trees, ['decky-mcp.device', 'decky-mcp.devices', 'decky-mcp.plugins', 'decky-mcp.unified']);
  assert.deepEqual(calls.webviewProviders.map(w => w.id), ['decky-mcp.preview']);
  const declared = pkg.contributes.views['decky-mcp'].map(v => v.id).sort();
  assert.deepEqual(declared, ['decky-mcp.device', 'decky-mcp.devices', 'decky-mcp.plugins', 'decky-mcp.preview', 'decky-mcp.unified']);
  return `createTreeView(${trees.join(', ')}), registerWebviewViewProvider(decky-mcp.preview)`;
});

await check('package.json: container, activation, commands, menus, layout setting', async () => {
  const container = pkg.contributes.viewsContainers.activitybar[0];
  assert.equal(container.id, 'decky-mcp');
  assert.equal(container.title, 'Decky');
  assert.equal(readFileSync(path.join(root, container.icon), 'utf8').includes('currentColor'), true);
  for (const v of pkg.contributes.views['decky-mcp']) assert.ok(pkg.activationEvents.includes(`onView:${v.id}`), v.id);
  assert.ok(pkg.activationEvents.includes('workspaceContains:plugin.json'));
  const declared = new Set(pkg.contributes.commands.map(c => c.command));
  const registered = new Set(calls.commands.keys());
  for (const id of declared) assert.ok(registered.has(id), `declared but not registered: ${id}`);
  for (const id of registered) assert.ok(declared.has(id), `registered but not declared: ${id}`);
  const menuCmds = Object.values(pkg.contributes.menus).flat().map(m => m.command);
  for (const id of menuCmds) assert.ok(declared.has(id), `menu refers to unknown command ${id}`);
  for (const m of Object.values(pkg.contributes.menus).flat()) evalWhen(m.when, new Map());
  const welcome = pkg.contributes.viewsWelcome.map(w => w.view).sort();
  assert.deepEqual(welcome, ['decky-mcp.device', 'decky-mcp.devices', 'decky-mcp.plugins', 'decky-mcp.unified']);
  const layoutSetting = pkg.contributes.configuration.properties['decky-mcp.sidebarLayout'];
  assert.equal(layoutSetting.default, 'devices-first');
  assert.deepEqual(layoutSetting.enum, ['devices-first', 'unified', 'classic']);
  assert.equal(pkg.contributes.configuration.properties['decky-mcp.openScreenOnConnect'].default, true);
  assert.equal(pkg.contributes.commands.find(c => c.command === 'decky-mcp.switchLayout').title, 'Switch sidebar layout');
  for (const v of pkg.contributes.views['decky-mcp']) {
    const gear = pkg.contributes.menus['view/title'].filter(m => m.command === 'decky-mcp.switchLayout' && evalWhen(m.when, new Map([['view', v.id]])));
    assert.equal(gear.length, 1, `layout gear on ${v.id}`);
  }
  assert.deepEqual(visibleViews(new Map()), ['decky-mcp.devices'], 'before activation the default layout shows');
  return `${declared.size} commands registered, ${menuCmds.length} menu entries resolve, gear on all 5 views`;
});

await check('first activation seeds one saved device from the settings', async () => {
  const list = globalState.get('decky-mcp.devices');
  assert.equal(list.length, 1);
  assert.equal(list[0].host, '10.1.2.3');
  assert.equal(globalState.get('decky-mcp.activeDevice'), list[0].id);
  return JSON.stringify({ name: list[0].name, host: list[0].host, port: list[0].port });
});

await check('devices-first (default), unpaired: only Devices visible, one row, Connect inline', async () => {
  assert.equal(calls.context.get('decky-mcp.layout'), 'devices-first');
  assert.equal(calls.context.get('decky-mcp.connected'), false);
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
  assert.deepEqual(deviceProvider().getChildren(), []);
  assert.equal(status(), '$(vm) Decky: not connected');
  return `row "${r.label}" — "${r.description}" [$(${r.iconPath.id})], inline ${itemMenu('decky-mcp.devices', r.contextValue, true).join(', ')}; status "${status()}"`;
});

await check('switch to classic: setting written, context set, every provider refreshed', async () => {
  const detail = await switchTo('classic');
  assert.deepEqual(visibleViews(), ['decky-mcp.device', 'decky-mcp.plugins', 'decky-mcp.preview']);
  return `${detail}; visible ${visibleViews().join(', ')}`;
});

await check('classic, not paired: empty trees (welcome content shows), context key false, status bar', async () => {
  assert.deepEqual(await deviceProvider().getChildren(), []);
  assert.deepEqual(await pluginsProvider().getChildren(), []);
  assert.equal(calls.context.get('decky-mcp.paired'), false);
  const view = tree('decky-mcp.device').view;
  assert.match(view.description, /not paired/);
  assert.match(status(), /\(not paired\)/);
  const welcome = pkg.contributes.viewsWelcome.filter(w => w.view === 'decky-mcp.device' && evalWhen(w.when, calls.context));
  assert.equal(welcome.length, 1);
  return `device view description "${view.description}", status "${status()}"`;
});

await check('classic, paired (via secret storage + fake device): device and plugin roots', async () => {
  await ctx.secrets.store(tokenKey, 'fake-token');
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
  assert.match(status(), /● 30 fps/);
  return `${labels(roots).join(' | ')}; screen "${roots[2].description}"; plugins ${labels(pl).join(', ')}`;
});

await check('classic: stats polling stops when the Device view is hidden', async () => {
  const t = tree('decky-mcp.device');
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
  calls.previewView = view;
  assert.match(webview.html, /default-src 'none'/);
  assert.match(webview.html, /img-src http:\/\/127\.0\.0\.1:\d+ blob:/);
  assert.match(webview.html, /Open full screen view/);
  assert.ok(!webview.html.includes('fake-token'));
  assert.equal(webview.options.enableScripts, true);
  return 'ok';
});

await check('classic: disconnect forgets the token and returns to the not-paired state', async () => {
  await run('decky-mcp.disconnect');
  await settle();
  assert.deepEqual(await deviceProvider().getChildren(), []);
  assert.equal(calls.context.get('decky-mcp.paired'), false);
  assert.equal(secrets.has(tokenKey), false);
});

await check('switch back to devices-first', async () => {
  const detail = await switchTo('devices-first');
  assert.deepEqual(visibleViews(), ['decky-mcp.devices']);
  assert.equal(status(), '$(vm) Decky: not connected');
  return detail;
});

await check('devices-first: Connect on an unpaired device pairs (403, then token) and connects', async () => {
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

await check('devices-first, connected: views, rows, actions, titles and status bar', async () => {
  await settle(100);
  assert.deepEqual(visibleViews(), ['decky-mcp.devices', 'decky-mcp.device', 'decky-mcp.plugins', 'decky-mcp.preview']);
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
  const roots = deviceProvider().getChildren();
  assert.equal(roots[0].label, 'Screen');
  assert.equal(roots[0].description, '30 fps · 19.5 Mbps');
  assert.equal(roots.length, 9);
  for (const a of roots.slice(1)) assert.ok(calls.commands.has(a.command.command), a.command.command);
  for (const a of roots) assert.ok(!['decky-mcp.pair', 'decky-mcp.enterToken', 'decky-mcp.connect'].includes(a.command.command));
  assert.deepEqual(labels(await pluginsProvider().getChildren()), ['Decky-MCP', 'Tender']);
  assert.equal(tree('decky-mcp.device').view.description, '10.1.2.3');
  assert.equal(tree('decky-mcp.plugins').view.description, '10.1.2.3');
  assert.equal(calls.previewView.description, '10.1.2.3');
  assert.equal(status(), '$(vm-connect) 10.1.2.3');
  return `row "${r.label}" — "${r.description}" [$(vm-connect) green], inline ${itemMenu('decky-mcp.devices', r.contextValue, true).join(', ')}; Device: ${labels(roots).join(', ')}`;
});

await check('connected: periodic /health flips to unreachable and back, token kept', async () => {
  device.up = false;
  await settle(150);
  let [r] = devicesProvider().getChildren();
  assert.equal(r.description, 'unreachable');
  assert.equal(r.iconPath.id, 'warning');
  assert.equal(calls.context.get('decky-mcp.connected'), true, 'views stay while the session is unreachable');
  assert.equal(tree('decky-mcp.device').view.description, '10.1.2.3 · unreachable');
  assert.equal(status(), '$(warning) 10.1.2.3 (unreachable)');
  assert.equal(secrets.get(tokenKey), 'fake-token');
  device.up = true;
  await settle(150);
  [r] = devicesProvider().getChildren();
  assert.equal(r.description, 'connected');
  assert.equal(status(), '$(vm-connect) 10.1.2.3');
  return 'connected → unreachable → connected';
});

await check('devices-first, paired but disconnected: Disconnect keeps the token, hides device views', async () => {
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
  assert.equal(secrets.get(tokenKey), 'fake-token');
  assert.equal(status(), '$(vm) Decky: not connected');
  return `row "${r.label}" — "${r.description}" [$(vm)]`;
});

await check('devices-first: Connect with a stored token checks /health and connects without pairing', async () => {
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

await check('devices-first: a rejected token (401) goes straight into pairing', async () => {
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

await check('switch to unified', async () => {
  await ctx.secrets.store(tokenKey, 'fake-token');
  await run('decky-mcp.connect', seedId());
  await settle();
  const detail = await switchTo('unified');
  assert.deepEqual(visibleViews(), ['decky-mcp.unified', 'decky-mcp.preview']);
  return `${detail}; visible ${visibleViews().join(', ')}`;
});

await check('unified: one row per device; connected expands to Screen / Plugins / Actions / Settings', async () => {
  await settle(100);
  const p = unifiedProvider();
  const roots = await p.getChildren();
  assert.deepEqual(labels(roots), ['10.1.2.3', '10.9.9.9:9000']);
  assert.equal(roots[0].collapsibleState, 2);
  assert.equal(roots[1].collapsibleState, 1);
  assert.equal(roots[0].iconPath.id, 'vm-connect');
  const kids = await p.getChildren(roots[0]);
  assert.deepEqual(labels(kids), ['Screen', 'Plugins', 'Actions', 'Settings']);
  assert.equal(kids[0].description, '30 fps · 19.5 Mbps');
  const pl = await p.getChildren(kids[1]);
  assert.deepEqual(labels(pl), ['Decky-MCP', 'Tender']);
  assert.deepEqual(itemMenu('decky-mcp.unified', 'plugin', true), ['decky-mcp.reloadPlugin', 'decky-mcp.pluginLogs']);
  assert.equal((await p.getChildren(kids[2])).length, 8);
  assert.deepEqual(labels(await p.getChildren(kids[3])), ['Edit', 'Copy viewer URL', 'Remove']);
  const all = [...kids, ...(await p.getChildren(kids[2])), ...(await p.getChildren(kids[3]))];
  for (const n of all) assert.ok(!['decky-mcp.pair', 'decky-mcp.enterToken', 'decky-mcp.connect'].includes(n.command?.command), n.label);
  const other = await p.getChildren(roots[1]);
  assert.deepEqual(labels(other), ['Connect', 'Edit', 'Remove']);
  assert.deepEqual(other[0].command.arguments, [globalState.get('decky-mcp.devices')[1].id]);
  assert.deepEqual(itemMenu('decky-mcp.unified', roots[0].contextValue, true), ['decky-mcp.disconnectDevice', 'decky-mcp.deviceActions']);
  return `${labels(roots).join(', ')}; connected → ${labels(kids).join(', ')}; other → ${labels(other).join(', ')}`;
});

await check('status bar QuickPick: connect/switch, disconnect, add, layout', async () => {
  let offered;
  ui.quickPick = (items, opts) => { offered = { labels: items.map(i => i.label), placeHolder: opts.placeHolder }; return undefined; };
  await run('decky-mcp.switchDevice');
  assert.equal(calls.statusItems[0].command ?? 'decky-mcp.switchDevice', 'decky-mcp.switchDevice');
  assert.equal(offered.placeHolder, 'Connected to 10.1.2.3');
  for (const want of [/vm-connect\) 10\.1\.2\.3/, /10\.9\.9\.9/, /Disconnect from 10\.1\.2\.3/, /Add device/, /Switch sidebar layout/]) {
    assert.ok(offered.labels.some(l => want.test(l)), `${want} in ${offered.labels}`);
  }
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
