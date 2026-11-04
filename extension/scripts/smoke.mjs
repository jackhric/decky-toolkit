// Activation smoke test against a stub `vscode` module; needs no device and no VS Code.
// Usage: node scripts/smoke.mjs
import * as esbuild from 'esbuild';
import assert from 'assert/strict';
import Module, { createRequire } from 'module';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

const outfile = path.join(root, 'out', 'smoke.cjs');
await esbuild.build({
  stdin: {
    contents: "export * from './src/extension'; export * from './src/actionsTree'; export * from './src/pluginsTree'; " +
      "export * from './src/pluginDeploy'; export * from './src/stage'; export { AUTO_DEPLOY_DEBOUNCE_MS } from './src/deploy';",
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
  watchers: [], output: [],
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
class RelativePattern { constructor(base, pattern) { this.base = base; this.pattern = pattern; } }
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

const settings = { host: '10.1.2.3', port: 8765, pluginDirName: '', 'deploy.build': 'never' };
const configEmitter = new EventEmitter();
const workspaceFolders = new EventEmitter();
const noop = async () => undefined;
const noopEvent = () => new Disposable();
const vscode = {
  EventEmitter, Disposable, TreeItem, ThemeIcon, ThemeColor, MarkdownString, Uri, RelativePattern,
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
      const item = { text: '', tooltip: '', visible: false, show() { this.visible = true; }, hide() { this.visible = false; }, dispose() { this.visible = false; } };
      calls.statusItems.push(item);
      return item;
    },
    createOutputChannel: name => ({
      name, appendLine: l => { if (name === 'Decky') calls.output.push(l + '\n'); }, append: t => { if (name === 'Decky') calls.output.push(t); }, show() {}, dispose() {},
    }),
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
    onDidChangeWorkspaceFolders: workspaceFolders.event,
    createFileSystemWatcher: pattern => {
      const change = new EventEmitter();
      const w = {
        pattern, disposed: false, onDidCreate: change.event, onDidDelete: noopEvent, onDidChange: change.event,
        fire: () => change.fire(), dispose() { this.disposed = true; },
      };
      calls.watchers.push(w);
      return w;
    },
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
let plugins = [
  { dir: 'decky-mcp', name: 'Decky-MCP', author: 'jackh', flags: ['root', 'debug'], api_version: 1, version: '0.1.0', has_backend: true },
  { dir: 'romm-tender', name: 'Tender', author: 'x', flags: [], api_version: 1, version: '0.33.0', has_backend: true },
];
const device = { up: true, pairQueue: [], installs: [], journal: ['boot'], pluginLog: {}, installMeta: { name: 'My Plugin', version: '1.2.3' }, downFor: 0 };
const frameJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
const fetched = [];
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  const auth = new Headers(init.headers).get('authorization');
  if (device.downFor > 0 && u.pathname === '/health') {
    device.downFor--;
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' } });
  }
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
  if (u.pathname === '/plugins/install' && init.method === 'POST') {
    const file = init.body.get('file');
    const dir = file.name.replace(/\.zip$/, '');
    const restart = u.searchParams.get('restart');
    device.installs.push({ dir, restart, bytes: file.size });
    const meta = device.installMeta;
    const loaded = `2026-11-04T00:00:00-05:00 bazzite PluginLoader[1]: [loader][INFO]: Loaded ${meta.name} (v${meta.version})`;
    if (!plugins.some(x => x.dir === dir)) plugins = [...plugins, { dir, name: meta.name, version: meta.version, flags: [], has_backend: true }];
    if (restart === 'plugin') device.journal.push(`${loaded} #${device.installs.length}`);
    // The watcher queues one reload per changed file.
    if (restart === 'none') for (const ms of [100, 400]) setTimeout(() => device.journal.push(`${loaded} #${device.installs.length}.${ms}`), ms);
    if (restart === 'loader') device.downFor = 1;
    device.pluginLog[dir] = [...(device.pluginLog[dir] ?? []), `[INFO]: ${meta.name} started #${device.installs.length}`];
    return json({ installed: { dir, name: meta.name, version: meta.version }, restarted: restart });
  }
  if (u.pathname === '/logs/tail') {
    const dir = u.searchParams.get('plugin');
    if (!dir) return json({ lines: device.journal.slice(-Number(u.searchParams.get('tail') ?? 100)) });
    return device.pluginLog[dir] ? json({ lines: device.pluginLog[dir].slice(-5) }) : json({ error: 'no log dir' }, 404);
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
    ['Deploy', 'decky-mcp.deploy'], ['Deploy (full restart)', 'decky-mcp.deployFull'], ['Reload backend', 'decky-mcp.reloadPlugin'],
    ['Show plugin logs', 'decky-mcp.pluginLogs'], ['Auto-deploy on change: Off', 'decky-mcp.toggleAutoDeploy']]],
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
  assert.equal(pkg.version, '0.5.0');
  const container = pkg.contributes.viewsContainers.activitybar[0];
  assert.equal(container.id, 'decky-mcp');
  assert.equal(container.title, 'Decky');
  assert.equal(readFileSync(path.join(root, container.icon), 'utf8').includes('currentColor'), true);
  for (const v of pkg.contributes.views['decky-mcp']) assert.ok(pkg.activationEvents.includes(`onView:${v.id}`), v.id);
  assert.equal(pkg.activationEvents.length, 7);
  for (const glob of ['plugin.json', '*/plugin.json', '*/*/plugin.json']) assert.ok(pkg.activationEvents.includes(`workspaceContains:${glob}`), glob);
  assert.deepEqual(pkg.contributes.keybindings, [{ command: 'decky-mcp.deploy', key: 'ctrl+alt+d', mac: 'cmd+alt+d' }]);
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
    ['decky-mcp.deploy.build', 'decky-mcp.deploy.onChange', 'decky-mcp.host', 'decky-mcp.openScreenOnConnect', 'decky-mcp.pluginDirName', 'decky-mcp.port']);
  assert.deepEqual(pkg.contributes.configuration.properties['decky-mcp.deploy.build'].enum, ['auto', 'always', 'never']);
  assert.equal(pkg.contributes.configuration.properties['decky-mcp.deploy.build'].default, 'auto');
  assert.equal(pkg.contributes.configuration.properties['decky-mcp.deploy.onChange'].default, false);
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

const scratch = mkdtempSync(path.join(tmpdir(), 'decky-smoke-'));
const put = (root, rel, text = '', mode = 0o644) => {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), text, { mode });
};
/** A decky-plugin-template checkout, trimmed. */
function makePlugin(root, { name = 'My Plugin', flags = [], version = '1.2.3', build = 'rollup -c', lock = 'pnpm-lock.yaml' } = {}) {
  put(root, 'plugin.json', JSON.stringify({ name, author: 'me', flags, api_version: 1 }, null, 2) + '\n');
  put(root, 'package.json', JSON.stringify({ name: 'x', version, scripts: { build } }, null, 2) + '\n');
  if (lock) put(root, lock);
  put(root, 'main.py', 'class Plugin: pass\n');
  put(root, 'src/index.tsx', 'export default 1;\n');
  put(root, 'dist/index.js', 'export default 1;\n');
  return root;
}
const setMtime = (root, rel, secondsAgo) => {
  const t = new Date(Date.now() - secondsAgo * 1000);
  utimesSync(path.join(root, rel), t, t);
};
async function openWorkspace(...folders) {
  vscode.workspace.workspaceFolders = folders.length ? folders.map(f => ({ name: path.basename(f), uri: Uri.file(f) })) : undefined;
  workspaceFolders.fire();
  await settle(300);
}
const statusButton = () => calls.statusItems.find(i => /Deploy|Deploying/.test(i.text));
const output = () => calls.output.join('');

await check('plugin detection: skeleton with and without the debug flag, depth <= 2, node_modules skipped', async () => {
  const ws = path.join(scratch, 'detect');
  makePlugin(path.join(ws, 'plain'), { name: 'Plain' });
  makePlugin(path.join(ws, 'group', 'debugged'), { name: 'Debugged', flags: ['debug', '_root'], version: '0.0.1' });
  makePlugin(path.join(ws, 'a', 'b', 'too-deep'), { name: 'Too Deep' });
  makePlugin(path.join(ws, 'node_modules', 'dep'), { name: 'Dependency' });
  makePlugin(path.join(ws, 'plain', 'py_modules', 'inner'), { name: 'Inner' });
  const roots = await ext.findPluginRoots(ws, 2);
  assert.deepEqual(roots.map(r => path.relative(ws, r)), [path.join('group', 'debugged'), 'plain']);
  const [debugged, plain] = await Promise.all(roots.map(r => ext.readWorkspacePlugin(r)));
  assert.deepEqual({ ...plain, root: undefined }, {
    root: undefined, name: 'Plain', author: 'me', flags: [], apiVersion: 1, version: '1.2.3', dir: 'plain', hasBackend: true, hasDebugFlag: false,
  });
  assert.equal(debugged.hasDebugFlag, true);
  assert.equal(debugged.dir, 'debugged');
  assert.equal(debugged.version, '0.0.1');
  assert.equal((await ext.readWorkspacePlugin(roots[1], ' custom-dir ')).dir, 'custom-dir');
  assert.equal(await ext.findPluginRoots(path.join(ws, 'plain'), 2).then(r => r.length), 1, 'a workspace that is the plugin');
  return `found ${roots.map(r => path.relative(ws, r)).join(', ')}; debug flag ${debugged.hasDebugFlag}/${plain.hasDebugFlag}`;
});

await check('build mode decisions: auto builds only when src/ is newer than dist/index.js', async () => {
  const root = makePlugin(path.join(scratch, 'build'));
  const decide = async mode => (await ext.buildDecision(root, mode));
  setMtime(root, 'src/index.tsx', 60);
  setMtime(root, 'dist/index.js', 30);
  assert.deepEqual(await decide('auto'), { build: false, reason: 'dist/index.js is up to date' });
  setMtime(root, 'main.py', 0);
  put(root, 'py_modules/lib.py', 'x = 1\n');
  assert.equal((await decide('auto')).build, false, 'Python changes never need a build');
  setMtime(root, 'src/index.tsx', 0);
  assert.deepEqual(await decide('auto'), { build: true, reason: 'src is newer than dist/index.js' });
  assert.equal((await decide('never')).build, false);
  setMtime(root, 'src/index.tsx', 60);
  assert.equal((await decide('always')).build, true);
  writeFileSync(path.join(root, 'dist/index.js'), '');
  execFileSync('rm', [path.join(root, 'dist/index.js')]);
  assert.deepEqual(await decide('auto'), { build: true, reason: 'dist/index.js is missing' });
  put(root, 'package.json', '{"version":"1.0.0"}');
  assert.equal((await decide('always')).build, false, 'no build script, nothing to run');
  assert.equal(await ext.packageManager(root), 'pnpm');
  const npm = makePlugin(path.join(scratch, 'npm'), { lock: 'package-lock.json' });
  assert.equal(await ext.packageManager(npm), 'npm');
  const none = makePlugin(path.join(scratch, 'nolock'), { lock: null });
  assert.equal(await ext.packageManager(none), 'pnpm');
  return 'up to date → skip, main.py/py_modules newer → skip, src newer → build, dist missing → build, never/always, no script → skip; pnpm/npm by lockfile';
});

await check('staging per skeleton: shipped files, skipped sources and caches, bin exec bit', async () => {
  const root = makePlugin(path.join(scratch, 'stage'), { flags: ['debug'] });
  for (const rel of ['LICENSE', 'README.md', 'defaults/defaults.txt', 'static/x.css', 'assets/logo.png', 'py_modules/lib/__init__.py',
    'backend/src/main.c', 'backend/Makefile', 'tests/test_x.py', 'node_modules/dep/index.js', '.git/HEAD', '.vscode/tasks.json',
    'py_modules/lib/__pycache__/x.cpython-314.pyc', 'py_modules/stale.pyc', 'py_modules/node_modules/x.js', 'decky.pyi', 'rollup.config.js']) put(root, rel, 'x');
  put(root, 'bin/tool', '#!/bin/sh\necho hi\n', 0o755);
  const { zip, files } = await ext.stagePlugin(root, 'my-plugin');
  const file = path.join(scratch, 'stage.zip');
  writeFileSync(file, zip);
  const listing = execFileSync('unzip', ['-Z1', file]).toString().trim().split('\n');
  const tops = [...new Set(listing.map(l => l.split('/')[1]).filter(Boolean))].sort();
  assert.deepEqual(tops, ['LICENSE', 'README.md', 'assets', 'bin', 'defaults', 'dist', 'main.py', 'package.json', 'plugin.json', 'py_modules', 'static']);
  assert.deepEqual(files, ['dist', 'plugin.json', 'package.json', 'main.py', 'LICENSE', 'README.md', 'defaults', 'py_modules', 'static', 'bin', 'assets']);
  for (const bad of ['__pycache__', '.pyc', 'node_modules', 'backend', '/src/', 'tests', '.git', '.vscode']) {
    assert.ok(!listing.some(l => l.includes(bad)), `${bad} shipped: ${listing.filter(l => l.includes(bad))}`);
  }
  const perms = execFileSync('unzip', ['-Z', file, 'my-plugin/bin/tool']).toString();
  assert.match(perms, /^-rwxr-xr-x/, perms);
  return `${listing.length} entries: ${tops.join(' ')}; bin/tool -rwxr-xr-x`;
});

await check('detected plugin: Plugin group "<name> v<version>", dir in tooltip, one prompt, status bar button', async () => {
  const root = makePlugin(path.join(scratch, 'ws', 'my-plugin'));
  calls.messages.length = 0;
  assert.equal(statusButton()?.visible ?? false, false, 'no button without a plugin');
  await openWorkspace(path.join(scratch, 'ws'));
  const prompts = () => calls.messages.filter(m => m.m.startsWith('Decky plugin detected'));
  assert.deepEqual(prompts().map(m => [m.m, m.buttons]), [['Decky plugin detected: My Plugin. Deploy to 10.1.2.3?', ['Deploy', 'Not now']]]);
  const { roots, kids } = await actionsTree();
  assert.equal(roots[1].description, 'My Plugin v1.2.3');
  assert.match(roots[1].tooltip, new RegExp(`from ${root}, deployed to ~/homebrew/plugins/my-plugin$`));
  for (const c of kids.Plugin) assert.equal(c.description, undefined);
  const b = statusButton();
  assert.equal(b.visible, true);
  assert.equal(b.text, '$(rocket) Deploy My Plugin');
  assert.equal(b.command, 'decky-mcp.deploy');
  fetched.length = 0;
  const reload = kids.Plugin[2];
  await run(reload.command.command, ...reload.command.arguments);
  assert.ok(fetched.includes('/plugins/my-plugin/reload'), fetched.join(', '));
  assert.equal(lastMessage('info').m, 'Decky-MCP: reloaded my-plugin.');
  await openWorkspace(path.join(scratch, 'ws'));
  assert.equal(prompts().length, 1, 'the prompt shows once per session');
  return `Plugin (${roots[1].description}); prompt "${prompts()[0].m}" [${prompts()[0].buttons.join(', ')}]; status bar "${b.text}"`;
});

await check('Deploy: first install restarts the loader, then fast deploys reload only the plugin', async () => {
  device.installs.length = 0;
  let duringDeploy;
  ui.onProgress = () => { duringDeploy = statusButton().text; };
  await run('decky-mcp.deploy');
  assert.equal(device.installs.at(-1).restart, 'loader', 'not installed yet');
  assert.match(lastMessage('info').m, /^Decky-MCP: Deployed My Plugin in \d+\.\d s \(loader restarted\)\.$/);
  assert.equal(duringDeploy, '$(sync~spin) Deploying My Plugin');
  assert.equal(statusButton().text, '$(rocket) Deploy My Plugin');
  calls.output.length = 0;
  await run('decky-mcp.deploy');
  assert.equal(device.installs.at(-1).restart, 'plugin');
  const first = lastMessage('info').m;
  assert.match(first, /^Decky-MCP: Deployed My Plugin in \d+\.\d s\.$/);
  assert.match(output(), /Build skipped: build mode "never"/);
  assert.match(output(), /Reload confirmed: loader imported My Plugin v1\.2\.3; backend: \[INFO\]: My Plugin started #2/);
  await run('decky-mcp.deployFull');
  assert.equal(device.installs.at(-1).restart, 'loader');
  assert.match(lastMessage('info').m, /\(loader restarted\)/);
  return `${device.installs.map(i => i.restart).join(' → ')}; "${first}"`;
});

await check('Deploy with the debug flag: restart=none, waits for the watcher reloads to settle', async () => {
  const root = path.join(scratch, 'ws', 'my-plugin');
  put(root, 'plugin.json', JSON.stringify({ name: 'My Plugin', author: 'me', flags: ['debug'], api_version: 1 }));
  await openWorkspace(path.join(scratch, 'ws'));
  calls.output.length = 0;
  const t0 = Date.now();
  await run('decky-mcp.deploy');
  assert.equal(device.installs.at(-1).restart, 'none');
  assert.match(output(), /debug flag set: waiting for the loader's file watcher/);
  assert.match(output(), /Reload confirmed: loader imported My Plugin v1\.2\.3 \(2 reloads\)/);
  assert.ok(Date.now() - t0 >= 1500, 'waited for the reloads to settle');
  assert.match(lastMessage('info').m, /^Decky-MCP: Deployed My Plugin in \d+\.\d s\.$/);
  return lastMessage('info').m;
});

await check('a failing build fails the deploy with its error line, nothing is uploaded', async () => {
  const root = path.join(scratch, 'ws', 'my-plugin');
  put(root, 'package.json', JSON.stringify({ version: '1.2.3', scripts: { build: `node -e "console.error('src/index.tsx(3,1): error TS1005: oops'); process.exit(2)"` } }));
  execFileSync('rm', ['-f', path.join(root, 'pnpm-lock.yaml')]);
  put(root, 'package-lock.json', '{}');
  settings['deploy.build'] = 'always';
  const installs = device.installs.length;
  let shown;
  ui.error = (m, buttons) => { shown = { m, buttons }; };
  await run('decky-mcp.deploy');
  assert.match(shown.m, /^Decky-MCP deploy failed: build failed: npm run build exited with code 2: src\/index\.tsx\(3,1\): error TS1005: oops$/);
  assert.deepEqual(shown.buttons, ['Show output']);
  assert.equal(device.installs.length, installs);
  assert.match(output(), /\$ npm run build/);
  return shown.m;
});

await check('auto-deploy on change: toggle leaf, watchers, one debounced deploy without a build', async () => {
  const root = path.join(scratch, 'ws', 'my-plugin');
  await run('decky-mcp.toggleAutoDeploy');
  assert.equal(settings['deploy.onChange'], true);
  const plugin = (await actionsProvider().getChildren())[1];
  const toggle = (await actionsProvider().getChildren(plugin))[4];
  assert.equal(toggle.label, 'Auto-deploy on change: On');
  assert.equal(toggle.iconPath.id, 'sync');
  const live = calls.watchers.filter(w => w.pattern instanceof RelativePattern && !w.disposed);
  assert.deepEqual(live.map(w => [w.pattern.base.fsPath, w.pattern.pattern]),
    [[root, 'dist/index.js'], [root, 'main.py'], [root, 'py_modules/**/*.py']]);
  const installs = device.installs.length;
  calls.statusMessages.length = 0;
  live[0].fire();
  live[1].fire();
  await settle(200);
  live[0].fire();
  await settle(ext.AUTO_DEPLOY_DEBOUNCE_MS + 2500);
  assert.equal(device.installs.length, installs + 1, 'one deploy for a burst of changes');
  const deployed = calls.statusMessages.at(-1);
  assert.match(deployed, /^\$\(check\) Deployed My Plugin in \d+\.\d s$/);
  await run('decky-mcp.toggleAutoDeploy');
  assert.equal(settings['deploy.onChange'], false);
  assert.ok(live.every(w => w.disposed), 'watchers disposed when turned off');
  return `3 changes → 1 install (restart=${device.installs.at(-1).restart}, build skipped despite deploy.build=always); "${deployed}"`;
});

await check('decky-mcp.pluginDirName overrides the deploy dir', async () => {
  settings.pluginDirName = 'other-dir';
  configEmitter.fire({ affectsConfiguration: s => s === 'decky-mcp.pluginDirName' || s === 'decky-mcp' });
  await settle(300);
  assert.match((await actionsProvider().getChildren())[1].tooltip, /~\/homebrew\/plugins\/other-dir/);
  settings.pluginDirName = '';
  settings['deploy.build'] = 'never';
  await openWorkspace();
  assert.equal(statusButton().visible, false, 'button hidden without a plugin');
  assert.equal((await actionsProvider().getChildren())[1].description, 'no plugin.json in workspace');
  return 'tooltip names other-dir; closing the folder hides the button';
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
