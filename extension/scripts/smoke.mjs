// Activation smoke test against a stub `vscode` module; needs no device and no VS Code.
// Usage: node scripts/smoke.mjs
import * as esbuild from 'esbuild';
import assert from 'assert/strict';
import Module, { createRequire } from 'module';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'fs';
import { hostname, tmpdir } from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

const outfile = path.join(root, 'out', 'smoke.cjs');
await esbuild.build({
  stdin: {
    contents: "export * from './src/extension'; export * from './src/actionsTree'; export * from './src/pluginsTree'; " +
      "export * from './src/pluginDeploy'; export * from './src/stage'; export { AUTO_DEPLOY_DEBOUNCE_MS } from './src/deploy'; " +
      "export * from './src/controllers'; export * from './src/navigation'; export { HttpError } from './src/client'; " +
      "export * from './src/games'; export * from './src/remoteFs';",
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
  watchers: [], output: [], fsProviders: [], folderUpdates: [], docs: [], revealed: [],
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
ThemeIcon.Folder = new ThemeIcon('folder');
ThemeIcon.File = new ThemeIcon('file');
class FileSystemError extends Error {
  constructor(m, code = 'Unknown') { super(String(m)); this.code = code; }
}
for (const code of ['FileNotFound', 'FileExists', 'FileNotADirectory', 'FileIsADirectory', 'NoPermissions', 'Unavailable']) {
  FileSystemError[code] = m => new FileSystemError(m, code);
}
class ThemeColor { constructor(id) { this.id = id; } }
class MarkdownString { value = ''; appendMarkdown(s) { this.value += s; return this; } }
class RelativePattern { constructor(base, pattern) { this.base = base; this.pattern = pattern; } }
const Uri = {
  parse: s => ({ toString: () => s, path: new URL(s).pathname }),
  file: p => ({ toString: () => `file://${p}`, path: p, fsPath: p }),
  joinPath: (u, ...p) => ({ toString: () => [u.toString(), ...p].join('/'), path: [u.path ?? '', ...p].join('/') }),
  from: ({ scheme, authority = '', path: p = '' }) => ({ scheme, authority, path: p, toString: () => `${scheme}://${authority}${p}` }),
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
  FileSystemError,
  FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
  FileChangeType: { Changed: 1, Created: 2, Deleted: 3 },
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
      const view = {
        id, visible: true, title: undefined, description: undefined, onDidChangeVisibility: visibility.event, dispose() {}, _visibility: visibility,
        reveal: async (node, opts) => { calls.revealed.push({ id, node, opts }); },
      };
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
    showTextDocument: async (doc, opts) => { calls.docs.push({ doc, opts }); return {}; },
    setStatusBarMessage: m => { calls.statusMessages.push(m); return new Disposable(); },
    withProgress: (o, fn) => {
      const entry = { title: o.title, messages: [] };
      calls.progress.push(entry);
      const cancel = new EventEmitter();
      entry.cancel = () => cancel.fire();
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
        configEmitter.fire({ affectsConfiguration: s => s === `decky-toolkit.${k}` || s === 'decky-toolkit' });
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
    registerFileSystemProvider: (scheme, provider, options) => { calls.fsProviders.push({ scheme, provider, options }); return new Disposable(); },
    updateWorkspaceFolders: (start, deleteCount, ...folders) => { calls.folderUpdates.push({ start, deleteCount, folders }); return true; },
    openTextDocument: async opts => ({ ...opts, uri: Uri.parse('untitled:Untitled-1') }),
    fs: {
      readFile: async u => { if (files.has(u.toString())) return files.get(u.toString()); throw new vscode.FileSystemError('nope'); },
      writeFile: async (u, data) => { calls.written.push({ uri: u.toString(), data }); },
    },
    asRelativePath: p => String(p),
  },
  env: { appName: 'Visual Studio Code', asExternalUri: async u => u, openExternal: async u => { calls.opened.push(u.toString()); return true; }, clipboard: { writeText: async t => { calls.clipboard.push(t); } } },
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
const health = { ok: true, name: 'decky-toolkit', version: '0.2.0', api_version: 1, tools: 15 };
const stats = { available: true, running: true, subscribers: 1, fps: 30, kbps: 19542, frames_total: 10, uptime_s: 1, width: 1920, height: 1080, settings: { fps: 30, quality: 70, width: 0, audio: true }, error: null };
const streamLimits = { fps: [1, 60], quality: [10, 100], widths: [0, 1600, 1280, 960, 640], audio: [false, true] };
let plugins = [
  { dir: 'decky-toolkit', name: 'Decky Toolkit', author: 'jackh', flags: ['root', 'debug'], api_version: 1, version: '0.1.0', has_backend: true },
  { dir: 'romm-tender', name: 'Tender', author: 'x', flags: [], api_version: 1, version: '0.33.0', has_backend: true },
];
const device = { up: true, pairQueue: [], pairRequests: [], pairCancelled: [], pairUnsupported: false, installs: [], journal: ['boot'], pluginLog: {}, installMeta: { name: 'My Plugin', version: '1.2.3' }, downFor: 0, inputSupported: true, input: { enabled: false, backend: 'ei', available: true, reason: null } };
const frameJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
// Controllers and Steam UI routes as in the API contract; `streams` are open /controllers/events bodies.
const steamDeck = { id: 'evdev:deck', name: 'Steam Deck', kind: 'physical', virtual_id: null, vendor: '28de', product: '1205', device: '/dev/input/event5', steam: { type: 'steamdeck', slot: 0, name: 'Steam Deck' } };
const ctl = {
  missing: false, eventsStatus: 200, refuse: null, nextId: 1, posts: [], streams: new Set(),
  controllers: [steamDeck, { id: 'evdev:auto', name: 'Decky Toolkit pad', kind: 'virtual', virtual_id: 'auto0', vendor: '045e', product: '028e', device: '/dev/input/event9', steam: { type: 'xbox360', slot: 1, name: 'Xbox 360 Controller' } }],
  virtual: [{ id: 'auto0', name: 'Decky Toolkit pad', type: 'x360', created_at: 1, last_event_at: 2, auto: true }],
};
const ctlPush = () => {
  const line = new TextEncoder().encode(`data: ${JSON.stringify({ type: 'controllers', controllers: ctl.controllers, virtual: ctl.virtual })}\n\n`);
  for (const s of ctl.streams) s.enqueue(line);
};
const ctlCloseStreams = () => { for (const s of ctl.streams) { try { s.close(); } catch { /* closed */ } } ctl.streams.clear(); };
const uiRoutes = {
  current: '/library/home',
  official: [{ path: '/library/home', title: 'Library' }, { path: '/library/app/{appid}', title: 'Game details', template: true }, { path: '/settings', title: 'Settings' }],
  plugins: [{ plugin: 'Tender', path: '/tender', title: 'Tender' }],
  quick_access_tabs: ['Notifications', 'Decky'],
};
const uiDevice = { missing: false, posts: [] };
// Library and game folders as the device reports them (Bazzite: Steam paths under /var/home, ~ is /home).
const ago = s => new Date(Date.now() - s * 1000).toISOString().replace(/\.\d+Z$/, '+00:00');
const STEAM = '/var/home/jackh/.local/share/Steam';
const CT_USER = `${STEAM}/steamapps/compatdata/2567870/pfx/drive_c/users/steamuser`;
const appVVVVVV = {
  appid: 70300, name: 'VVVVVV', type: 'game', installed: true, running: true, install_dir: `${STEAM}/steamapps/common/vvvvvv`,
  compat_tool: 'steamlinuxruntime_sniper', compat_tool_display: 'Steam Linux Runtime 3.0', size_on_disk: 75883262, library: STEAM, last_played: ago(300),
};
const appChained = {
  appid: 2567870, name: 'Chained Together', type: 'game', installed: true, running: false, install_dir: `${STEAM}/steamapps/common/ChainedTogether`,
  compat_tool: 'proton_11', compat_tool_display: 'Proton 11.0-2', size_on_disk: 8493964009, library: STEAM, last_played: ago(3700),
};
const appRom = {
  appid: 4289220546, name: '1080° Avalanche', type: 'shortcut', installed: true, running: false, install_dir: '/home/jackh/.local/share/romm-tender/bin',
  compat_tool: null, compat_tool_display: null, size_on_disk: 0, library: null, last_played: null,
};
const appRemote = { ...appChained, appid: 220, name: 'Half-Life 2', installed: false, last_played: ago(10) };
const entry = (path, exists = true) => ({ path, exists, ...(exists ? { mtime: ago(9000) } : {}) });
const userDirs = (base, present, matches = {}) => Object.fromEntries([
  ['appdata_roaming', 'AppData/Roaming'], ['appdata_local', 'AppData/Local'], ['appdata_locallow', 'AppData/LocalLow'],
  ['documents', 'Documents'], ['saved_games', 'Saved Games'],
].map(([k, rel]) => [k, { ...entry(`${base}/${rel}`, present.includes(k)), matches: matches[k] ?? [] }]));
const dirsChained = {
  appid: 2567870, name: 'Chained Together', platform: 'proton', compat_tool: 'proton_11', steam_root: STEAM,
  install_dir: entry(`${STEAM}/steamapps/common/ChainedTogether`), compatdata: entry(`${STEAM}/steamapps/compatdata/2567870`),
  prefix: entry(`${STEAM}/steamapps/compatdata/2567870/pfx`),
  prefix_user_dirs: userDirs(CT_USER, ['appdata_roaming', 'appdata_local', 'documents', 'saved_games'], { appdata_local: [`${CT_USER}/AppData/Local/ChainedTogether`] }),
  account_id: '95599472', userdata: entry(`${STEAM}/userdata/95599472/2567870`), cloud_remote: entry(`${STEAM}/userdata/95599472/2567870/remote`, false),
  shader_cache: entry(`${STEAM}/steamapps/shadercache/2567870`), xdg: [],
};
const savesChained = {
  appid: 2567870, name: 'Chained Together', steam_cloud: [], notes: [],
  candidates: [
    { path: `${CT_USER}/AppData/Local/ChainedTogether/Saved/SaveGames/Progress.sav`, size: 30519, mtime: ago(3650), found_by: 'steam_cloud remotecache (root 3)', rank: 0, score: 0 },
    { path: `${CT_USER}/AppData/Local/ChainedTogether/Saved/SaveGames/Save.sav`, size: 2348, mtime: ago(20000), found_by: 'steam_cloud remotecache (root 3)', rank: 0, score: 0 },
    { path: `${CT_USER}/AppData/Local/ChainedTogether/Saved/Config/Windows/GameUserSettings.ini`, size: 900, mtime: ago(20000), found_by: 'heuristic: under a dir named after the game', rank: 2, score: 3 },
  ],
};
const dirsVVVVVV = {
  appid: 70300, name: 'VVVVVV', platform: 'native', compat_tool: 'steamlinuxruntime_sniper', steam_root: STEAM,
  install_dir: entry(`${STEAM}/steamapps/common/vvvvvv`), compatdata: entry(`${STEAM}/steamapps/compatdata/70300`),
  prefix: entry(`${STEAM}/steamapps/compatdata/70300/pfx`, false), prefix_user_dirs: userDirs(`${STEAM}/steamapps/compatdata/70300/pfx/drive_c/users/steamuser`, []),
  account_id: '95599472', userdata: entry(`${STEAM}/userdata/95599472/70300`), cloud_remote: entry(`${STEAM}/userdata/95599472/70300/remote`, false),
  shader_cache: entry(`${STEAM}/steamapps/shadercache/70300`), xdg: [{ ...entry('/home/jackh/.local/share/VVVVVV'), base: '/home/jackh/.local/share' }],
};
const savesVVVVVV = {
  appid: 70300, name: 'VVVVVV', steam_cloud: [], notes: [],
  candidates: [
    { path: '/home/jackh/.local/share/VVVVVV/saves/unlock.vvv', size: 2214, mtime: ago(320), found_by: 'steam_cloud remotecache (root 2)', rank: 0, score: 0 },
    { path: '/home/jackh/.local/share/VVVVVV/saves/tsave.vvv', size: 2523, mtime: ago(400000), found_by: 'steam_cloud remotecache (root 2)', rank: 0, score: 0 },
    { path: '/home/jackh/.local/share/VVVVVV/saves/settings.vvv', size: 1675, mtime: ago(320), found_by: 'steam_autocloud.vdf marker in dir', rank: 1, score: 0 },
  ],
};
const games = {
  missing: false, toolCalls: [],
  apps: [appRom, appChained, appVVVVVV, appRemote],
  dirs: { 70300: dirsVVVVVV, 2567870: dirsChained },
  saves: { 70300: savesVVVVVV, 2567870: savesChained },
  tools: {
    app_launch: a => ({ appid: a.appid, name: 'Chained Together', launched: true, running: true }),
    app_terminate: a => ({ appid: a.appid, name: 'VVVVVV', terminated: true, running: false }),
    proton_log: a => ({
      appid: a.appid,
      proton_log: { path: `/home/jackh/steam-${a.appid}.log`, exists: false, hint: 'set the launch option PROTON_LOG=1 %command% and run the game to create it' },
      steam_logs: [{ file: `${STEAM}/logs/compat_log.txt`, mtime: ago(60), lines: [`StartSession: appID ${a.appid}`] }],
    }),
  },
};

// In-memory device file system behind the /fs routes, with the server's guards: login files are refused,
// writes only under ~/.local/share/VVVVVV, DELETE needs confirm=1.
const fakeFs = { missing: false, nodes: new Map(), log: [] };
const fsDir = p => (p.lastIndexOf('/') <= 0 ? '/' : p.slice(0, p.lastIndexOf('/')));
const fsBase = p => p.slice(p.lastIndexOf('/') + 1);
const fsPut = (p, type, data, extra = {}) => fakeFs.nodes.set(p, { type, data: data === undefined ? undefined : new TextEncoder().encode(data), mtime: '2026-11-04T09:35:42+00:00', ...extra });
for (const d of ['/', '/home', '/home/jackh', '/home/jackh/.local', '/home/jackh/.local/share', '/home/jackh/.local/share/VVVVVV',
  '/home/jackh/.local/share/VVVVVV/saves', '/home/jackh/.local/share/Steam', '/home/jackh/.local/share/Steam/config']) fsPut(d, 'dir');
fsPut('/home/jackh/.local/share/VVVVVV/saves/tsave.vvv', 'file', '<Save/>');
fsPut('/home/jackh/.local/share/VVVVVV/saves/unlock.vvv', 'file', '<Unlock/>');
fsPut('/home/jackh/.local/share/VVVVVV/current', 'symlink', undefined, { target: 'saves' });
fsPut('/home/jackh/.local/share/Steam/config/loginusers.vdf', 'file', 'secret');
const fsSensitive = p => /loginusers\.vdf$/.test(p ?? '');
const fsWritable = p => p.startsWith('/home/jackh/.local/share/VVVVVV/');
async function fsRoute(u, init, json) {
  const method = init.method ?? 'GET';
  fakeFs.log.push(`${method} ${u.pathname}${u.search}`);
  if (fakeFs.missing) return new Response('404: Not Found', { status: 404 });
  const fail = (status, code, error) => json({ error, code }, status);
  const nodes = fakeFs.nodes;
  const p = u.searchParams.get('path')?.replace(/^~(?=\/|$)/, '/home/jackh');
  const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
  const refused = x => fail(403, 'EACCES', fsSensitive(x) ? `refused: ${x} holds Steam login credentials` : `refused: ${x} is not inside a game install dir`);
  if (u.pathname === '/fs' && method === 'GET') {
    let real = p, n = nodes.get(p);
    if (n?.type === 'symlink') { real = `${fsDir(p)}/${n.target}`; n = nodes.get(real); }
    if (fsSensitive(p)) return refused(p);
    if (!n || n.type !== 'dir') return fail(404, 'ENOENT', `not a directory: ${p}`);
    const glob = u.searchParams.get('glob');
    let entries = [...nodes].filter(([k]) => k !== real && fsDir(k) === real).map(([k, v]) => ({
      path: fsBase(k), type: v.type, size: v.data?.length ?? 0, mtime: v.mtime, ...(v.target ? { target: v.target } : {}), ...(fsSensitive(k) ? { sensitive: true } : {}),
    }));
    if (glob) entries = entries.filter(e => e.path === glob.replace(/\[(.)\]/g, '$1'));
    return json({ path: p, depth: 1, glob, entries, count: entries.length, truncated: false });
  }
  if (u.pathname === '/fs/read') {
    const n = nodes.get(p);
    if (fsSensitive(p)) return refused(p);
    if (!n) return fail(404, 'ENOENT', `no such file: ${p}`);
    if (n.type === 'dir') return fail(409, 'EISDIR', `is a directory: ${p}`);
    return new Response(n.data, { headers: { 'content-type': 'application/octet-stream' } });
  }
  if (u.pathname === '/fs/write' && method === 'PUT') {
    const n = nodes.get(p);
    if (fsSensitive(p) || !fsWritable(p)) return refused(p);
    if (n?.type === 'dir') return fail(409, 'EISDIR', `is a directory: ${p}`);
    if (n && u.searchParams.get('overwrite') === '0') return fail(409, 'EEXIST', `exists: ${p}`);
    if (!n && u.searchParams.get('create') === '0') return fail(404, 'ENOENT', p);
    for (let d = fsDir(p); !nodes.has(d); d = fsDir(d)) fsPut(d, 'dir');
    nodes.set(p, { type: 'file', data: new Uint8Array(init.body), mtime: '2026-11-04T10:00:00+00:00' });
    return json({ path: p, bytes: init.body.length, created: !n });
  }
  if (u.pathname === '/fs/mkdir' && method === 'POST') {
    if (!fsWritable(body.path)) return refused(body.path);
    if (nodes.has(body.path)) return fail(409, 'EEXIST', `exists: ${body.path}`);
    if (!nodes.has(fsDir(body.path))) return fail(404, 'ENOENT', 'parent directory does not exist');
    fsPut(body.path, 'dir');
    return json({ path: body.path, created: true });
  }
  if (u.pathname === '/fs/rename' && method === 'POST') {
    if (!fsWritable(body.from)) return refused(body.from);
    if (!fsWritable(body.to)) return refused(body.to);
    if (!nodes.has(body.from)) return fail(404, 'ENOENT', body.from);
    if (nodes.has(body.to) && !body.overwrite) return fail(409, 'EEXIST', `exists: ${body.to}`);
    for (const [k, v] of [...nodes]) {
      if (k === body.from || k.startsWith(`${body.from}/`)) { nodes.delete(k); nodes.set(body.to + k.slice(body.from.length), v); }
    }
    return json({ from: body.from, to: body.to });
  }
  if (u.pathname === '/fs' && method === 'DELETE') {
    if (u.searchParams.get('confirm') !== '1') return json({ error: 'deleting is destructive: add confirm=1' }, 400);
    if (fsSensitive(p) || !fsWritable(p)) return refused(p);
    if (!nodes.has(p)) return fail(404, 'ENOENT', p);
    for (const k of [...nodes.keys()]) if (k === p || k.startsWith(`${p}/`)) nodes.delete(k);
    return json({ deleted: p, files: 1, bytes: 0 });
  }
  return new Response('405: Method Not Allowed', { status: 405 });
}

const fetched = [];
globalThis.fetch = async (url, init = {}) => {
  let u = new URL(url);
  let auth = new Headers(init.headers).get('authorization');
  // Requests through the extension's loopback proxy: the proxy adds the token.
  if (u.hostname === '127.0.0.1') {
    u = new URL(`http://${settings.host}:${settings.port}${u.pathname.replace(/^\/[^/]+/, '')}${u.search}`);
    auth = 'Bearer fake-token';
  }
  if (device.downFor > 0 && u.pathname === '/health') {
    device.downFor--;
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' } });
  }
  if (!device.up || u.hostname === '10.9.9.9') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' } });
  fetched.push(u.pathname);
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (u.pathname === '/health') return json(health);
  // Pairing requests: each poll answers with the next entry of pairQueue ('pending' once it is empty).
  if (u.pathname === '/pair/request' && init.method === 'POST') {
    if (device.pairUnsupported) return new Response('Unauthorized', { status: 401 });
    const n = device.pairRequests.length;
    const req = { id: `req${n}`, code: String(4821 + n), body: JSON.parse(init.body) };
    device.pairRequests.push(req);
    return json({ id: req.id, code: req.code, poll_after_ms: 1000 }, 201);
  }
  const pairReq = /^\/pair\/request\/([^/]+)$/.exec(u.pathname);
  if (pairReq && init.method === 'DELETE') {
    device.pairCancelled.push(pairReq[1]);
    return json({ cancelled: true });
  }
  if (pairReq) {
    const next = device.pairQueue.shift() ?? 'pending';
    if (next === 'down') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET', message: 'socket hang up' } });
    if (next === 'gone') return json({ error: 'unknown or expired pairing request' }, 404);
    if (next === 'approved') return json({ status: 'approved', token: 'fake-token', url: `http://${u.host}`, api_version: 1 });
    if (next === 'pending') await new Promise(r => setTimeout(r, 5));
    return json({ status: next });
  }
  if (auth !== 'Bearer fake-token') return new Response('unauthorized', { status: 401 });
  if (u.pathname === '/stream/stats') return json(stats);
  if (u.pathname === '/stream/settings') {
    if (device.streamSettingsMissing) return json({ error: 'capture not available' }, 404);
    if (init.method === 'PUT') {
      device.streamPuts = [...(device.streamPuts ?? []), JSON.parse(init.body)];
      stats.settings = { ...stats.settings, ...JSON.parse(init.body) };
    }
    return json({ ...stats.settings, limits: streamLimits });
  }
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
  if (u.pathname === '/input/settings') {
    if (!device.inputSupported) return new Response('404: Not Found', { status: 404 });
    if (init.method === 'PUT') device.input = { ...device.input, enabled: JSON.parse(init.body).enabled };
    return json(device.input);
  }
  if (u.pathname.startsWith('/controllers') && ctl.missing) return new Response('404: Not Found', { status: 404 });
  if (u.pathname === '/controllers') return json({ controllers: ctl.controllers, virtual: ctl.virtual, input_enabled: device.input.enabled });
  if (u.pathname === '/controllers/events') {
    if (ctl.eventsStatus !== 200) return json({ error: 'events unavailable' }, ctl.eventsStatus);
    let c;
    const body = new ReadableStream({ start(ctrl) { c = ctrl; ctl.streams.add(ctrl); }, cancel() { ctl.streams.delete(c); } });
    init.signal?.addEventListener('abort', () => { ctl.streams.delete(c); try { c.error(new DOMException('aborted', 'AbortError')); } catch { /* closed */ } });
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  }
  if (u.pathname === '/controllers/virtual' && init.method === 'POST') {
    const req = JSON.parse(init.body);
    ctl.posts.push(req);
    if (ctl.refuse) return json({ error: ctl.refuse }, 422);
    if (ctl.virtual.filter(v => !v.auto).length >= 4) return json({ error: 'all 4 virtual controller slots are in use' }, 409);
    const id = `v${ctl.nextId++}`;
    const name = req.name ?? `Virtual pad ${ctl.nextId - 1}`;
    ctl.virtual.push({ id, name, type: 'x360', created_at: 3, last_event_at: null, auto: false });
    ctl.controllers.push({ id: `evdev:${id}`, name, kind: 'virtual', virtual_id: id, vendor: '045e', product: '028e', device: `/dev/input/event1${ctl.nextId}`, steam: { type: 'xbox360', slot: ctl.controllers.length, name: 'Xbox 360 Controller' } });
    ctlPush();
    return json({ id, name, type: 'x360' }, 201);
  }
  const removePad = /^\/controllers\/virtual\/([^/]+)$/.exec(u.pathname);
  if (removePad && init.method === 'DELETE') {
    const id = decodeURIComponent(removePad[1]);
    if (!ctl.virtual.some(v => v.id === id)) return json({ error: `unknown virtual controller ${id}` }, 404);
    ctl.virtual = ctl.virtual.filter(v => v.id !== id);
    ctl.controllers = ctl.controllers.filter(c => c.virtual_id !== id);
    ctlPush();
    return json({ removed: id });
  }
  if (u.pathname.startsWith('/ui/') && uiDevice.missing) return new Response('404: Not Found', { status: 404 });
  if (u.pathname === '/ui/routes') return json(uiRoutes);
  if (u.pathname === '/ui/navigate' && init.method === 'POST') {
    const body = JSON.parse(init.body);
    uiDevice.posts.push(body);
    if (body.path && !/^\/(library|settings|tender)/.test(body.path)) return json({ error: `unknown path ${body.path}`, official: uiRoutes.official.map(r => r.path) }, 400);
    if (body.path) uiRoutes.current = body.path;
    return json({ ok: true, current: body.path ?? (body.action === 'plugin' ? `/quickaccess/${body.plugin}` : uiRoutes.current) });
  }
  if (u.pathname === '/apps' || u.pathname.startsWith('/apps/')) {
    if (games.missing) return new Response('404: Not Found', { status: 404 });
    if (u.pathname === '/apps') return json({ count: games.apps.length, apps: games.apps });
    const m = /^\/apps\/(\d+)\/(dirs|saves)$/.exec(u.pathname);
    const body = m && games[m[2]][m[1]];
    return body ? json(body) : json({ error: 'app is not in this Steam library' }, 404);
  }
  if (u.pathname === '/mcp' && init.method === 'POST') {
    const { id, params } = JSON.parse(init.body);
    games.toolCalls.push(params);
    const reply = games.tools[params.name]?.(params.arguments);
    const result = reply === undefined
      ? { content: [{ type: 'text', text: `unknown tool ${params.name}` }], isError: true }
      : { content: [{ type: 'text', text: JSON.stringify(reply) }], isError: false };
    return json({ jsonrpc: '2.0', id, result });
  }
  if (u.pathname === '/fs' || u.pathname.startsWith('/fs/')) return fsRoute(u, init, json);
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
const visibleViews = (context = calls.context) => pkg.contributes.views['decky-toolkit'].filter(v => evalWhen(v.when, context)).map(v => v.id);
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
const tokenKey = 'decky-toolkit.token:10.1.2.3:8765';
const lastMessage = kind => calls.messages.filter(m => m.kind === kind).at(-1);

ext.connectionTimings.healthPollMs = 40;
ext.pairingTimings.retryMs = 20;
ext.controllerTimings.pollMs = 40;

await ext.activate(ctx);
await settle();

const tree = id => calls.treeViews.find(t => t.id === id);
const actionsProvider = () => tree('decky-toolkit.actions').provider;
const pluginsProvider = () => tree('decky-toolkit.plugins').provider;
const devicesProvider = () => tree('decky-toolkit.devices').provider;
const status = () => calls.statusItems[0].text;
const seedId = () => globalState.get('decky-toolkit.devices')[0].id;
const titleMenu = view => pkg.contributes.menus['view/title'].filter(m => evalWhen(m.when, new Map([...calls.context, ['view', view]]))).map(m => m.command);
const dupes = list => list.filter((x, i) => list.indexOf(x) !== i);

const EXPECTED_ACTIONS = {
  Screen: ['device-desktop', 2, [
    ['Open screen panel', 'decky-toolkit.openScreen'], ['Open viewer in browser', 'decky-toolkit.openViewer'], ['Snapshot to file', 'decky-toolkit.snapshot']]],
  Plugin: ['package', 2, [
    ['Deploy', 'decky-toolkit.deploy'], ['Deploy (full restart)', 'decky-toolkit.deployFull'], ['Reload backend', 'decky-toolkit.reloadPlugin'],
    ['Show plugin logs', 'decky-toolkit.pluginLogs'], ['Auto-deploy on change: Off', 'decky-toolkit.toggleAutoDeploy']]],
  Loader: ['server', 2, [
    ['Restart loader', 'decky-toolkit.restartLoader'], ['Show loader logs', 'decky-toolkit.loaderLogs'], ['Install plugin zip…', 'decky-toolkit.installZip']]],
  Steam: ['game', 1, [
    ['Navigate to…', 'decky-toolkit.navigate'], ['Open save data…', 'decky-toolkit.openGameSaves'], ['Open plugin panel…', 'decky-toolkit.openPluginPanel'], ['Back', 'decky-toolkit.uiBack'],
    ['Quick Access', 'decky-toolkit.uiQuickAccess'], ['Close menus', 'decky-toolkit.uiCloseMenus'],
    ['Evaluate JS in Steam UI', 'decky-toolkit.evaluate'], ['Toast on device', 'decky-toolkit.toast']]],
  MCP: ['server-process', 1, [
    ['Write MCP config for this workspace', 'decky-toolkit.writeMcpConfig'], ['Copy MCP URL', 'decky-toolkit.copyMcpUrl'], ['Copy token', 'decky-toolkit.copyToken']]],
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
  for (const bad of ['decky-toolkit.connect', 'decky-toolkit.disconnectDevice', 'decky-toolkit.pairAgain', 'decky-toolkit.enterToken', 'decky-toolkit.disconnect']) {
    assert.ok(!leafCmds.includes(bad), `${bad} in the Actions view`);
  }
  return { roots, kids };
}

await check('activate() registers the six views and the decky: file system', async () => {
  const trees = [...calls.treeViews.map(t => t.id), ...calls.treeProviders.map(t => t.id)].sort();
  assert.deepEqual(trees, ['decky-toolkit.actions', 'decky-toolkit.controllers', 'decky-toolkit.devices', 'decky-toolkit.games', 'decky-toolkit.plugins']);
  assert.deepEqual(calls.fsProviders.map(f => [f.scheme, f.options]), [['decky', { isCaseSensitive: true }]]);
  assert.deepEqual(calls.webviewProviders.map(w => w.id), ['decky-toolkit.preview']);
  const declared = pkg.contributes.views['decky-toolkit'].map(v => [v.id, v.name]);
  assert.deepEqual(declared, [
    ['decky-toolkit.devices', 'Devices'], ['decky-toolkit.actions', 'Actions'], ['decky-toolkit.plugins', 'Plugins'], ['decky-toolkit.games', 'Games'],
    ['decky-toolkit.controllers', 'Controllers'], ['decky-toolkit.preview', 'Preview']]);
  const games = pkg.contributes.views['decky-toolkit'].find(v => v.id === 'decky-toolkit.games');
  assert.equal(games.visibility, 'collapsed', 'Games starts collapsed like Plugins and Controllers');
  return `createTreeView(${trees.join(', ')}), registerWebviewViewProvider(decky-toolkit.preview)`;
});

await check('package.json: container, activation, commands, menus, version', async () => {
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/, 'Marketplace and Open VSX accept only major.minor.patch');
  assert.equal(pkg.contributes.configuration.properties['decky-toolkit.host'].default, '', 'no device is preconfigured for new users');
  const container = pkg.contributes.viewsContainers.activitybar[0];
  assert.equal(container.id, 'decky-toolkit');
  assert.equal(container.title, 'Decky');
  assert.equal(readFileSync(path.join(root, container.icon), 'utf8').includes('currentColor'), true);
  for (const v of pkg.contributes.views['decky-toolkit']) assert.ok(pkg.activationEvents.includes(`onView:${v.id}`), v.id);
  assert.equal(pkg.activationEvents.length, 10);
  assert.ok(pkg.activationEvents.includes('onFileSystem:decky'), 'restored decky:// folders activate the extension');
  for (const glob of ['plugin.json', '*/plugin.json', '*/*/plugin.json']) assert.ok(pkg.activationEvents.includes(`workspaceContains:${glob}`), glob);
  assert.deepEqual(pkg.contributes.keybindings, [{ command: 'decky-toolkit.deploy', key: 'ctrl+alt+d', mac: 'cmd+alt+d' }]);
  for (const v of pkg.contributes.views['decky-toolkit']) {
    assert.ok(v.id === 'decky-toolkit.devices' ? v.when === undefined : v.when === 'decky-toolkit.connected', `${v.id} when: ${v.when}`);
  }
  const declared = new Set(pkg.contributes.commands.map(c => c.command));
  const registered = new Set(calls.commands.keys());
  for (const id of declared) assert.ok(registered.has(id), `declared but not registered: ${id}`);
  for (const id of registered) assert.ok(declared.has(id), `registered but not declared: ${id}`);
  const menus = Object.values(pkg.contributes.menus).flat();
  for (const m of menus) assert.ok(declared.has(m.command), `menu refers to unknown command ${m.command}`);
  for (const m of menus) evalWhen(m.when, new Map());
  const whens = [...menus.map(m => m.when), ...pkg.contributes.views['decky-toolkit'].map(v => v.when), ...pkg.contributes.viewsWelcome.map(w => w.when)];
  const allowedKeys = new Set(['view', 'viewItem', 'decky-toolkit.connected', 'false']);
  for (const w of whens.filter(Boolean)) {
    for (const [, key] of w.replace(/\/(?:\\.|[^/])+\//g, '/re/').matchAll(/(?:^|&&|\|\||\(|!)\s*([A-Za-z][\w.-]*)/g)) assert.ok(allowedKeys.has(key), `context key ${key} in ${w}`);
  }
  assert.deepEqual(pkg.contributes.viewsWelcome.map(w => w.view), ['decky-toolkit.devices', 'decky-toolkit.controllers']);
  assert.deepEqual(Object.keys(pkg.contributes.configuration.properties).sort(),
    ['decky-toolkit.deploy.build', 'decky-toolkit.deploy.onChange', 'decky-toolkit.host', 'decky-toolkit.openScreenOnConnect', 'decky-toolkit.pluginDirName', 'decky-toolkit.port']);
  assert.deepEqual(pkg.contributes.configuration.properties['decky-toolkit.deploy.build'].enum, ['auto', 'always', 'never']);
  assert.equal(pkg.contributes.configuration.properties['decky-toolkit.deploy.build'].default, 'auto');
  assert.equal(pkg.contributes.configuration.properties['decky-toolkit.deploy.onChange'].default, false);
  assert.equal(pkg.contributes.configuration.properties['decky-toolkit.openScreenOnConnect'].default, true);
  const titles = {
    'decky-toolkit.devices': ['decky-toolkit.addDevice', 'decky-toolkit.refresh'],
    'decky-toolkit.actions': ['decky-toolkit.openScreen', 'decky-toolkit.refresh'],
    'decky-toolkit.plugins': ['decky-toolkit.installZip', 'decky-toolkit.refreshPlugins'],
    'decky-toolkit.games': ['decky-toolkit.findGame', 'decky-toolkit.openDeckyPath', 'decky-toolkit.refreshGames'],
    'decky-toolkit.controllers': ['decky-toolkit.addVirtualController', 'decky-toolkit.refreshControllers'],
    'decky-toolkit.preview': ['decky-toolkit.openScreen'],
  };
  for (const [view, want] of Object.entries(titles)) assert.deepEqual(titleMenu(view), want, `${view} title`);
  for (const view of Object.keys(titles)) {
    for (const viewItem of ['plugin', 'deck.unpaired', 'deck.paired', 'deck.session', 'deck.busy', 'action', 'group.screen', 'controller.virtual', 'controller.physical', 'controller.unsupported',
      'game', 'game.running', 'game.unsupported', 'deckyDir', 'deckyFile', 'gameGroup', 'gameLog']) {
      for (const inline of [true, false]) assert.deepEqual(dupes(itemMenu(view, viewItem, inline)), [], `${view} ${viewItem}`);
    }
  }
  assert.deepEqual(visibleViews(new Map()), ['decky-toolkit.devices'], 'before activation only Devices shows');
  return `${declared.size} commands registered, ${menus.length} menu entries resolve, titles ${Object.values(titles).map(t => t.length).join('/')}`;
});

await check('first activation seeds one saved device from the settings', async () => {
  const list = globalState.get('decky-toolkit.devices');
  assert.equal(list.length, 1);
  assert.equal(list[0].host, '10.1.2.3');
  assert.equal(globalState.get('decky-toolkit.activeDevice'), list[0].id);
  return JSON.stringify({ name: list[0].name, host: list[0].host, port: list[0].port });
});

await check('unpaired: only Devices visible, one row, Connect inline', async () => {
  assert.equal(calls.context.get('decky-toolkit.connected'), false);
  assert.deepEqual([...calls.context.keys()], ['decky-toolkit.connected'], 'the only context key');
  assert.deepEqual(visibleViews(), ['decky-toolkit.devices']);
  const rows = devicesProvider().getChildren();
  assert.equal(rows.length, 1);
  const [r] = rows;
  assert.equal(r.label, '10.1.2.3', 'name equal to host is shown once');
  assert.equal(r.description, 'not paired');
  assert.equal(r.iconPath.id, 'key');
  assert.equal(r.contextValue, 'deck.unpaired');
  assert.deepEqual(r.command, { command: 'decky-toolkit.connect', title: 'Connect', arguments: [seedId()] });
  assert.deepEqual(itemMenu('decky-toolkit.devices', r.contextValue, true), ['decky-toolkit.connect', 'decky-toolkit.deviceActions']);
  assert.ok(!itemMenu('decky-toolkit.devices', r.contextValue, false).includes('decky-toolkit.pairAgain'));
  assert.deepEqual(await actionsProvider().getChildren(), []);
  assert.deepEqual(await pluginsProvider().getChildren(), []);
  assert.equal(status(), '$(vm) Decky: not connected');
  return `row "${r.label}" — "${r.description}" [$(${r.iconPath.id})], inline ${itemMenu('decky-toolkit.devices', r.contextValue, true).join(', ')}; status "${status()}"`;
});

await check('fake client: plugin tree states, Actions Screen offline when unreachable', async () => {
  const fakeConn = (client, extra = {}) => ({
    devices: [], activeDevice: undefined, address: { host: 'h', port: 1 }, label: 'h', paired: !!client, tokenRejected: false,
    connectedDevice: client ? { id: 'x', name: 'h', host: 'h', port: 1 } : undefined,
    health: { kind: 'ok', health }, onDidChange: new EventEmitter().event, onDidChangeTarget: new EventEmitter().event,
    authedClient: () => client, watchStats: () => new Disposable(), ...extra,
  });
  const ok = new ext.PluginsTreeProvider(fakeConn({ listPlugins: async () => plugins }));
  assert.deepEqual(labels(await ok.getChildren()), ['Decky Toolkit', 'Tender']);
  const empty = new ext.PluginsTreeProvider(fakeConn({ listPlugins: async () => [] }));
  assert.deepEqual(labels(await empty.getChildren()), ['No plugins installed']);
  const broken = new ext.PluginsTreeProvider(fakeConn({ listPlugins: async () => { throw new Error('boom'); } }));
  const [p] = await broken.getChildren();
  assert.match(p.label, /Could not load plugins: boom/);
  assert.equal(p.command.command, 'decky-toolkit.refreshPlugins');
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

await check('Connect on an unpaired device files a pairing request, waits for approval and connects', async () => {
  fetched.length = 0;
  device.pairQueue = ['pending', 'approved'];
  let rowDuringPairing;
  ui.onProgress = () => { rowDuringPairing = devicesProvider().getChildren()[0]; };
  await run('decky-toolkit.connect', seedId());
  await settle();
  assert.equal(fetched.filter(p => p === '/pair/request').length, 1, 'one request');
  assert.equal(fetched.filter(p => p === '/pair/request/req0').length, 2, 'polled until approved');
  assert.ok(!fetched.slice(0, fetched.indexOf('/pair/request')).includes('/stream/stats'), 'no token, so no token check before pairing');
  assert.deepEqual(device.pairRequests[0].body, { client_name: `VS Code on ${hostname()}`, client_kind: 'vscode' });
  const prog = calls.progress.at(-1);
  assert.equal(prog.title, 'Decky Toolkit');
  assert.equal(prog.messages[0], 'Waiting for approval on 10.1.2.3 · code 4821. On the device: Quick Access → Decky Toolkit → Approve.');
  assert.ok(!prog.messages.some(m => /\d+ s\b|120/.test(m)), 'no countdown');
  assert.equal(rowDuringPairing.description, 'waiting for approval · code 4821');
  assert.equal(rowDuringPairing.contextValue, 'deck.busy');
  assert.equal(secrets.get(tokenKey), 'fake-token');
  assert.equal(calls.context.get('decky-toolkit.connected'), true);
  const info = lastMessage('info');
  assert.equal(info.m, 'Decky Toolkit: Paired with 10.1.2.3.');
  assert.deepEqual(info.buttons, ['Open screen', 'Deploy plugin']);
  assert.equal(calls.panels.length, 1, 'openScreenOnConnect opened the screen panel');
  assert.equal(calls.messages.filter(m => m.kind === 'warning' || m.kind === 'error').length, 0, 'no extra prompts');
  return `progress "${prog.title}: ${prog.messages[0]}", then "${info.m}" [${info.buttons.join(', ')}], screen panel opened`;
});

await check('connected: views, device row, titles and status bar', async () => {
  await settle(100);
  assert.deepEqual(visibleViews(), ['decky-toolkit.devices', 'decky-toolkit.actions', 'decky-toolkit.plugins', 'decky-toolkit.games', 'decky-toolkit.controllers', 'decky-toolkit.preview']);
  const [r] = devicesProvider().getChildren();
  assert.equal(r.label, '10.1.2.3');
  assert.equal(r.description, 'connected');
  assert.equal(r.iconPath.id, 'vm-connect');
  assert.equal(r.iconPath.color.id, 'testing.iconPassed');
  assert.equal(r.contextValue, 'deck.session');
  assert.equal(r.command, undefined);
  assert.deepEqual(itemMenu('decky-toolkit.devices', r.contextValue, true), ['decky-toolkit.disconnectDevice', 'decky-toolkit.deviceActions']);
  const ctxMenu = itemMenu('decky-toolkit.devices', r.contextValue, false);
  for (const bad of ['decky-toolkit.connect', 'decky-toolkit.pair']) assert.ok(!ctxMenu.includes(bad), `${bad} on a connected device`);
  assert.ok(ctxMenu.includes('decky-toolkit.pairAgain'));
  assert.equal(pkg.contributes.commands.find(c => c.command === 'decky-toolkit.pairAgain').title, 'Re-pair');
  assert.deepEqual(labels(await pluginsProvider().getChildren()), ['Decky Toolkit', 'Tender']);
  assert.equal(tree('decky-toolkit.actions').view.description, '10.1.2.3');
  assert.equal(tree('decky-toolkit.plugins').view.description, '10.1.2.3');
  assert.equal(calls.previewView.description, '10.1.2.3');
  assert.equal(status(), '$(vm-connect) 10.1.2.3');
  return `row "${r.label}" — "${r.description}" [$(vm-connect) green], inline ${itemMenu('decky-toolkit.devices', r.contextValue, true).join(', ')}; visible ${visibleViews().join(', ')}`;
});

await check('connected, no plugin.json: Actions roots Screen / Plugin / Loader / Steam / MCP with their leaves', async () => {
  const { roots, kids } = await actionsTree();
  const [screen, plugin] = roots;
  assert.equal(screen.description, '30 fps · 19.5 Mbps', 'stats polled because the Actions view is visible');
  assert.match(kids.Screen[1].tooltip, /http:\/\/10\.1\.2\.3:8765\/viewer/);
  assert.match(kids.Screen[1].tooltip, /asks for access/);
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
  assert.equal(b.command, 'decky-toolkit.deploy');
  fetched.length = 0;
  const reload = kids.Plugin[2];
  await run(reload.command.command, ...reload.command.arguments);
  assert.ok(fetched.includes('/plugins/my-plugin/reload'), fetched.join(', '));
  assert.equal(lastMessage('info').m, 'Decky Toolkit: reloaded my-plugin.');
  await openWorkspace(path.join(scratch, 'ws'));
  assert.equal(prompts().length, 1, 'the prompt shows once per session');
  return `Plugin (${roots[1].description}); prompt "${prompts()[0].m}" [${prompts()[0].buttons.join(', ')}]; status bar "${b.text}"`;
});

await check('Deploy: first install restarts the loader, then fast deploys reload only the plugin', async () => {
  device.installs.length = 0;
  let duringDeploy;
  ui.onProgress = () => { duringDeploy = statusButton().text; };
  await run('decky-toolkit.deploy');
  assert.equal(device.installs.at(-1).restart, 'loader', 'not installed yet');
  assert.match(lastMessage('info').m, /^Decky Toolkit: Deployed My Plugin in \d+\.\d s \(loader restarted\)\.$/);
  assert.equal(duringDeploy, '$(sync~spin) Deploying My Plugin');
  assert.equal(statusButton().text, '$(rocket) Deploy My Plugin');
  calls.output.length = 0;
  await run('decky-toolkit.deploy');
  assert.equal(device.installs.at(-1).restart, 'plugin');
  const first = lastMessage('info').m;
  assert.match(first, /^Decky Toolkit: Deployed My Plugin in \d+\.\d s\.$/);
  assert.match(output(), /Build skipped: build mode "never"/);
  assert.match(output(), /Reload confirmed: loader imported My Plugin v1\.2\.3; backend: \[INFO\]: My Plugin started #2/);
  await run('decky-toolkit.deployFull');
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
  await run('decky-toolkit.deploy');
  assert.equal(device.installs.at(-1).restart, 'none');
  assert.match(output(), /debug flag set: waiting for the loader's file watcher/);
  assert.match(output(), /Reload confirmed: loader imported My Plugin v1\.2\.3 \(2 reloads\)/);
  assert.ok(Date.now() - t0 >= 1500, 'waited for the reloads to settle');
  assert.match(lastMessage('info').m, /^Decky Toolkit: Deployed My Plugin in \d+\.\d s\.$/);
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
  await run('decky-toolkit.deploy');
  assert.match(shown.m, /^Decky Toolkit deploy failed: build failed: npm run build exited with code 2: src\/index\.tsx\(3,1\): error TS1005: oops$/);
  assert.deepEqual(shown.buttons, ['Show output']);
  assert.equal(device.installs.length, installs);
  assert.match(output(), /\$ npm run build/);
  return shown.m;
});

await check('auto-deploy on change: toggle leaf, watchers, one debounced deploy without a build', async () => {
  const root = path.join(scratch, 'ws', 'my-plugin');
  await run('decky-toolkit.toggleAutoDeploy');
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
  await run('decky-toolkit.toggleAutoDeploy');
  assert.equal(settings['deploy.onChange'], false);
  assert.ok(live.every(w => w.disposed), 'watchers disposed when turned off');
  return `3 changes → 1 install (restart=${device.installs.at(-1).restart}, build skipped despite deploy.build=always); "${deployed}"`;
});

await check('decky-toolkit.pluginDirName overrides the deploy dir', async () => {
  settings.pluginDirName = 'other-dir';
  configEmitter.fire({ affectsConfiguration: s => s === 'decky-toolkit.pluginDirName' || s === 'decky-toolkit' });
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
  await run('decky-toolkit.openViewer');
  assert.equal(calls.opened.at(-1), 'http://10.1.2.3:8765/viewer');
  ui.saveDialog = opts => opts.defaultUri;
  await run('decky-toolkit.snapshot');
  const dlg = calls.saveDialogs.at(-1);
  assert.match(dlg.defaultUri.toString(), /\/screen-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.jpg$/);
  const w = calls.written.at(-1);
  assert.equal(w.uri, dlg.defaultUri.toString());
  assert.deepEqual([...w.data], [...frameJpeg]);
  assert.match(lastMessage('info').m, /saved .*screen-.*\.jpg/);
  await run('decky-toolkit.copyMcpUrl');
  assert.equal(calls.clipboard.at(-1), 'http://10.1.2.3:8765/mcp');
  await run('decky-toolkit.copyToken');
  assert.equal(calls.clipboard.at(-1), 'fake-token');
  assert.match(lastMessage('warning').m, /secret/);
  return `opened ${calls.opened.at(-1)}; snapshot → ${dlg.defaultUri.path.split('/').pop()} (${w.data.length} B); token warning "${lastMessage('warning').m}"`;
});

await check('remote input: screen panel toggle, toggle command, status bar, unavailable / unsupported', async () => {
  const panel = calls.panels[0];
  const lastState = () => panel._posted.filter(m => m.type === 'input').at(-1)?.state;
  assert.match(panel.webview.html, /connect-src http:\/\/127\.0\.0\.1:(\d+) ws:\/\/127\.0\.0\.1:\1;/);
  assert.match(panel.webview.html, /<button id="inp"[^>]*>Input<\/button>/);
  assert.doesNotMatch(panel.webview.html, /id="mode|>Game<|ointer lock/i, 'no UI/Game switch, no pointer lock');
  assert.equal(pkg.contributes.commands.find(c => c.command === 'decky-toolkit.toggleInput').title, 'Toggle remote input');
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

  await run('decky-toolkit.toggleInput');
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
  await run('decky-toolkit.toggleInput');
  assert.match(lastMessage('warning').m, /not supported by this device version/);
  await settle();
  assert.deepEqual(lastState(), { supported: false, enabled: false, available: false, backend: null, reason: 'not supported by this device version' });

  device.inputSupported = true;
  device.input = { enabled: false, backend: 'ei', available: true, reason: null };
  await run('decky-toolkit.refresh');
  await settle(100);
  assert.equal(lastState().available, true);
  return 'panel Input on → $(keyboard) in status bar → palette toggle off → unavailable warning → 404 → "not supported by this device version"';
});

await check('screen panel: stream settings popover, audio controls, mute/volume in screen.js', async () => {
  const panel = calls.panels[0];
  const html = panel.webview.html;
  for (const id of ['gear', 's-fps', 's-quality', 's-width', 's-audio', 'mute', 'vol', 'a-hint', 'akbps', 'full']) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.match(html, /<option value="24">24 fps<\/option>/);
  assert.match(html, /<option value="640">640 px<\/option>/);
  assert.match(html, /script-src 'nonce-[^']+' blob:; worker-src blob:/);
  const streamMsgs = () => panel._posted.filter(m => m.type === 'stream');

  // ready → GET /stream/settings → settings posted (with audio).
  panel._posted.length = 0; fetched.length = 0;
  panel._received.fire({ type: 'ready' });
  await settle();
  assert.ok(fetched.includes('/stream/settings'));
  assert.deepEqual(streamMsgs().at(-1).settings, { fps: 30, quality: 70, width: 0, audio: true, limits: streamLimits });

  // setStream goes through the extension (PUT); unknown or ill-typed fields are dropped.
  panel._posted.length = 0;
  panel._received.fire({ type: 'setStream', patch: { fps: 60, audio: false, bitrate: 9, quality: '80' } });
  await settle();
  assert.deepEqual(device.streamPuts.at(-1), { fps: 60, audio: false });
  const reply = streamMsgs().at(-1);
  assert.deepEqual(reply.applied, ['fps', 'audio']);
  assert.equal(reply.settings.fps, 60);
  assert.equal(reply.settings.audio, false);

  // A change made elsewhere arrives with the stats tick.
  stats.settings = { ...stats.settings, audio: true };
  panel._posted.length = 0;
  await run('decky-toolkit.refresh');
  await settle(100);
  assert.ok(streamMsgs().some(m => m.settings?.audio === true && !m.applied), 'tick posted the new audio flag');

  // 404 hides the popover.
  device.streamSettingsMissing = true;
  panel._posted.length = 0;
  panel._received.fire({ type: 'ready' });
  await settle();
  assert.equal(streamMsgs().at(-1).settings, null);
  device.streamSettingsMissing = false;
  stats.settings = { fps: 30, quality: 70, width: 0, audio: true };

  // The real media/screen.js in a minimal DOM: mute and volume are local, settings go out as setStream.
  const src = readFileSync(path.join(root, 'media', 'screen.js'), 'utf8');
  const els = new Map();
  const el = id => {
    if (!els.has(id)) {
      const classes = new Set();
      els.set(id, {
        id, textContent: '', hidden: false, value: '', checked: false, disabled: false, title: '',
        addEventListener() {}, setAttribute() {}, focus() {},
        classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c), toggle: (c, on) => ((on ?? !classes.has(c)) ? classes.add(c) : classes.delete(c), classes.has(c)) },
      });
    }
    return els.get(id);
  };
  const listeners = [], posted = [];
  let state;
  const fakeVscode = { postMessage: m => posted.push(m), getState: () => state, setState: s => { state = s; } };
  const document = { getElementById: el, body: { dataset: { base: 'http://127.0.0.1:1/x' } }, addEventListener() {} };
  const window = { addEventListener: (t, fn) => { if (t === 'message') listeners.push(fn); } };
  const fakeFetch = () => new Promise(() => {});
  class FakeWs { constructor(url) { this.url = url; FakeWs.opened.push(url); } close() {} }
  FakeWs.opened = [];
  new Function('acquireVsCodeApi', 'document', 'window', 'fetch', 'WebSocket', 'requestAnimationFrame', src)(
    () => fakeVscode, document, window, fakeFetch, FakeWs, () => 0);
  const post = data => listeners.forEach(fn => fn({ data }));
  assert.deepEqual(posted.at(-1), { type: 'ready' });
  assert.equal(el('audio-ctl').hidden, true, 'audio controls hidden until the device says audio is on');
  post({ type: 'stream', settings: { fps: 30, quality: 70, width: 0, audio: true } });
  assert.equal(el('settings').hidden, false);
  assert.equal(el('s-fps').value, '30');
  assert.equal(el('s-audio').checked, true);
  assert.equal(el('audio-ctl').hidden, false);
  assert.equal(el('a-hint').hidden, false, 'no running AudioContext yet → "click to enable audio"');
  assert.ok(FakeWs.opened.some(u => u.endsWith('/audio')), 'audio socket opened');
  assert.equal(el('mute').textContent, '🔊', 'unmuted by default');
  el('mute').onclick();
  assert.equal(el('mute').textContent, '🔇');
  assert.equal(state.muted, true);
  el('vol').value = 35; el('vol').oninput();
  assert.equal(el('mute').textContent, '🔊', 'moving the volume unmutes');
  assert.deepEqual({ muted: state.muted, volume: state.volume }, { muted: false, volume: 0.35 });
  el('s-width').value = '960'; el('s-width').onchange();
  assert.deepEqual(posted.at(-1), { type: 'setStream', patch: { width: 960 } });
  assert.equal(el('s-fps').disabled, true);
  assert.equal(el('s-note').textContent, 'Applying…');
  post({ type: 'stream', settings: { fps: 30, quality: 70, width: 0, audio: true } });
  assert.equal(el('s-width').value, '960', 'stale tick ignored while applying');
  post({ type: 'stream', settings: { fps: 30, quality: 70, width: 960, audio: true }, applied: ['width'] });
  el('s-audio').checked = false; el('s-audio').onchange();
  assert.deepEqual(posted.at(-1), { type: 'setStream', patch: { audio: false } });
  post({ type: 'stream', settings: { fps: 30, quality: 70, width: 960, audio: false }, applied: ['audio'] });
  assert.equal(el('audio-ctl').hidden, true, 'device-wide off hides the local controls');
  assert.equal(el('s-fps').disabled, false);
  post({ type: 'stream', error: 'boom' });
  assert.equal(el('s-note').textContent, 'Failed: boom');
  post({ type: 'stream', settings: null });
  assert.equal(el('settings').hidden, true, '404 hides the Stream button');
  return 'ready → GET, setStream → PUT {fps, audio} only, tick mirrors, 404 → hidden; screen.js: mute 🔇/🔊, volume 0.35 saved, Applying… → done, audio off hides controls';
});

await check('Controllers view with fake clients: empty, physical + virtual, 404, error', async () => {
  const fakeConn = client => ({ connectedDevice: { id: 'x', name: 'h', host: 'h', port: 1 }, authedClient: () => client, onDidChangeTarget: new EventEmitter().event, label: 'h' });
  const treeFor = controllers => new ext.ControllersTreeProvider(new ext.ControllerWatcher(fakeConn({ controllers }), async () => 'http://127.0.0.1:1/x'));

  assert.deepEqual(await treeFor(async () => ({ controllers: [], virtual: [], input_enabled: false })).getChildren(), [], 'empty → welcome');
  const welcome = pkg.contributes.viewsWelcome.find(w => w.view === 'decky-toolkit.controllers').contents;
  assert.equal(welcome, 'No controllers seen by Steam Input.\n[Add virtual controller](command:decky-toolkit.addVirtualController)');

  const list = {
    controllers: [
      steamDeck,
      { id: 'evdev:v1', name: 'Virtual pad 1', kind: 'virtual', virtual_id: 'v1', vendor: '045e', product: '028e', device: '/dev/input/event12', steam: { type: 'xbox360', slot: 1, name: 'Xbox 360 Controller' } },
      { id: 'evdev:8bd', name: '8BitDo Pro 2', kind: 'physical', virtual_id: null, vendor: '2dc8', product: '6003', device: '/dev/input/event7', steam: null },
    ],
    virtual: [{ id: 'v1', name: 'Virtual pad 1', type: 'x360', auto: false }, { id: 'v2', name: 'Couch', type: 'x360', auto: false }],
    input_enabled: true,
  };
  const rows = await treeFor(async () => list).getChildren();
  assert.deepEqual(rows.map(r => [r.label, r.description]), [
    ['1. Steam Deck', 'physical · Steam Input: steamdeck · Slot 1'],
    ['2. Virtual pad 1', 'virtual · Steam Input: xbox360 · Slot 2'],
    ['8BitDo Pro 2', 'physical · not seen by Steam Input'],
    ['Couch (virtual)', 'virtual · not seen by Steam Input'],
  ]);
  assert.deepEqual(rows.map(r => [r.iconPath.id, r.iconPath.color?.id]), [['game', undefined], ['game', 'charts.blue'], ['game', undefined], ['game', 'charts.blue']]);
  assert.deepEqual(rows.map(r => r.virtualId), [undefined, 'v1', undefined, 'v2']);
  const ctx = new Map([['decky-toolkit.connected', true]]);
  const inline = r => pkg.contributes.menus['view/item/context'].filter(m => m.group.startsWith('inline') && evalWhen(m.when, new Map([...ctx, ['view', 'decky-toolkit.controllers'], ['viewItem', r.contextValue]]))).map(m => m.command);
  assert.deepEqual(rows.map(inline), [[], ['decky-toolkit.removeVirtualController'], [], ['decky-toolkit.removeVirtualController']]);
  assert.match(rows[1].tooltip.value, /Steam Input: xbox360, Slot 2/);

  const [old] = await treeFor(async () => { throw new ext.HttpError(404, '404: Not Found', '/controllers'); }).getChildren();
  assert.deepEqual([old.label, old.description, old.iconPath.color.id, old.contextValue], ['Controllers', 'update Decky Toolkit on the device', 'disabledForeground', 'controller.unsupported']);
  assert.deepEqual(inline(old), []);
  const [err] = await treeFor(async () => { throw new Error('boom'); }).getChildren();
  assert.equal(err.label, 'Could not load controllers: boom');
  assert.equal(err.command.command, 'decky-toolkit.refreshControllers');
  return rows.map(r => `${r.label} — ${r.description}`).join(' | ') + `; 404 → "${old.description}"`;
});

await check('Controllers view live: SSE through the proxy, add / remove, 409 and Steam Input refusal as-is, poll fallback, 404', async () => {
  const provider = tree('decky-toolkit.controllers').provider;
  const rowLabels = async () => labels(await provider.getChildren());
  await settle(100);
  assert.deepEqual(await rowLabels(), ['1. Steam Deck', '2. Decky Toolkit pad (virtual)']);
  assert.equal(tree('decky-toolkit.controllers').view.description, '10.1.2.3');
  assert.ok(fetched.includes('/controllers/events'), 'events requested through the proxy');
  assert.ok(ctl.streams.size >= 1, 'event stream open');

  // A change on the device arrives over SSE, without polling.
  fetched.length = 0;
  ctl.controllers = [...ctl.controllers, { id: 'evdev:8bd', name: '8BitDo Pro 2', kind: 'physical', virtual_id: null, vendor: '2dc8', product: '6003', device: '/dev/input/event7', steam: null }];
  ctlPush();
  await settle(120);
  assert.deepEqual(await rowLabels(), ['1. Steam Deck', '2. Decky Toolkit pad (virtual)', '8BitDo Pro 2']);
  assert.ok(!fetched.includes('/controllers'), 'no polling while the stream is open');

  // Add: optional name, Enter takes "Virtual pad N" (the auto pad does not count).
  let prompt;
  ui.inputBox = opts => { prompt = opts; return ''; };
  await run('decky-toolkit.addVirtualController');
  await settle();
  assert.equal(prompt.placeHolder, 'Virtual pad 1');
  assert.deepEqual(ctl.posts.at(-1), { name: 'Virtual pad 1' });
  assert.equal(lastMessage('info').m, 'Decky Toolkit: Virtual controller added and recognised by Steam Input (Virtual pad 1).');
  let rows = await provider.getChildren();
  const added = rows.find(r => String(r.label).endsWith('Virtual pad 1'));
  assert.equal(added.description, 'virtual · Steam Input: xbox360 · Slot 4');

  ui.inputBox = () => 'Couch';
  await run('decky-toolkit.addVirtualController');
  assert.deepEqual(ctl.posts.at(-1), { name: 'Couch' });
  ui.inputBox = () => undefined;
  const posts = ctl.posts.length;
  await run('decky-toolkit.addVirtualController');
  assert.equal(ctl.posts.length, posts, 'Escape adds nothing');

  // Remove: inline on the row, or a pick from the palette.
  await run('decky-toolkit.removeVirtualController', added);
  await settle();
  assert.ok(!(await rowLabels()).includes('Virtual pad 1'));
  let offered;
  ui.quickPick = items => { offered = labels(items); return items.find(i => i.label === 'Couch'); };
  await run('decky-toolkit.removeVirtualController');
  await settle();
  assert.deepEqual(offered, ['Decky Toolkit pad', 'Couch']);
  assert.ok(!(await rowLabels()).includes('Couch (virtual)'));

  // Refusals: the server's text as-is.
  ui.inputBox = () => '';
  ctl.refuse = 'Steam Input did not pick up the new pad within 5 s; it was removed';
  await run('decky-toolkit.addVirtualController');
  assert.equal(lastMessage('warning').m, 'Decky Toolkit: Steam Input did not pick up the new pad within 5 s; it was removed');
  ctl.refuse = null;
  for (let i = 0; i < 4; i++) await run('decky-toolkit.addVirtualController');
  await run('decky-toolkit.addVirtualController');
  assert.equal(lastMessage('warning').m, 'Decky Toolkit: all 4 virtual controller slots are in use');
  for (const v of ctl.virtual.filter(p => !p.auto)) await run('decky-toolkit.removeVirtualController', v.id);

  // The stream fails: a 5 s poll (40 ms here) keeps the list current and the stream is retried.
  ctl.eventsStatus = 500;
  ctlCloseStreams();
  await settle(60);
  ctl.controllers = ctl.controllers.filter(c => c.id !== 'evdev:8bd');
  await settle(150);
  assert.deepEqual(await rowLabels(), ['1. Steam Deck', '2. Decky Toolkit pad (virtual)'], 'poll picked up the change');
  ctl.eventsStatus = 200;
  await settle(150);
  assert.ok(ctl.streams.size >= 1, 'stream reopened');

  // An older device: one disabled row, add explains.
  ctl.missing = true;
  ctlCloseStreams();
  await settle(150);
  rows = await provider.getChildren();
  assert.deepEqual(rows.map(r => [r.label, r.description]), [['Controllers', 'update Decky Toolkit on the device']]);
  await run('decky-toolkit.addVirtualController');
  assert.match(lastMessage('warning').m, /update Decky Toolkit on the device \(10\.1\.2\.3\)/);
  ctl.missing = false;
  await settle(150);
  assert.deepEqual(await rowLabels(), ['1. Steam Deck', '2. Decky Toolkit pad (virtual)'], 'recovers once the device answers');
  return `SSE update, add "Virtual pad 1" (slot 3), remove inline + palette, refusal and 409 as-is, poll fallback, 404 → "${rows[0].description}"`;
});

await check('screen panel: "Forward to" select (pads message, addPad, pad field on gamepad messages)', async () => {
  const panel = calls.panels[0];
  assert.match(panel.webview.html, /<select id="pad-target"[^>]*><option value="">Auto<\/option><\/select>/);
  const padMsgs = () => panel._posted.filter(m => m.type === 'pads');
  panel._posted.length = 0;
  panel._received.fire({ type: 'ready' });
  await settle();
  assert.deepEqual(padMsgs().at(-1), { type: 'pads', pads: [] }, 'the auto pad is "Auto", not a choice');
  ui.inputBox = () => 'Couch';
  panel._received.fire({ type: 'addPad' });
  await settle(100);
  const id = ctl.virtual.find(v => v.name === 'Couch').id;
  assert.deepEqual(padMsgs().at(-1), { type: 'pads', pads: [{ id, name: 'Couch' }], select: id }, 'the new pad is selected');
  ctl.missing = true;
  await run('decky-toolkit.refreshControllers');
  await settle();
  assert.deepEqual(padMsgs().at(-1), { type: 'pads', pads: null }, '404 hides the select');
  ctl.missing = false;
  await run('decky-toolkit.refreshControllers');
  await settle();
  await run('decky-toolkit.removeVirtualController', id);

  // The real media/screen.js: the chosen id goes into the `pad` field.
  const src = readFileSync(path.join(root, 'media', 'screen.js'), 'utf8');
  const els = new Map();
  const el = eid => {
    if (!els.has(eid)) {
      const classes = new Set();
      const options = [];
      els.set(eid, {
        id: eid, textContent: '', hidden: eid === 'pad-ind' || eid === 'pad-fwd', value: '', checked: false, disabled: false, title: '', options,
        add: o => options.push(o), remove: i => options.splice(i, 1),
        addEventListener() {}, setAttribute() {}, focus() {},
        classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c), toggle: (c, on) => ((on ?? !classes.has(c)) ? classes.add(c) : classes.delete(c), classes.has(c)) },
      });
    }
    return els.get(eid);
  };
  const listeners = {}, posted = [], sent = [];
  let state;
  const fakeVscode = { postMessage: m => posted.push(m), getState: () => state, setState: s => { state = s; } };
  const document = { getElementById: el, body: { dataset: { base: 'http://127.0.0.1:1/x' } }, addEventListener() {}, hasFocus: () => true };
  const window = { addEventListener: (t, fn) => { (listeners[t] ??= []).push(fn); } };
  class FakeWs { constructor(url) { this.url = url; this.readyState = 1; FakeWs.last = this; } send(d) { sent.push(JSON.parse(d)); } close() {} }
  FakeWs.OPEN = 1;
  class Option { constructor(text, value) { this.text = text; this.value = value; } }
  let gamepads = [];
  const navigator = { getGamepads: () => gamepads };
  new Function('acquireVsCodeApi', 'document', 'window', 'fetch', 'WebSocket', 'requestAnimationFrame', 'Option', 'navigator', src)(
    () => fakeVscode, document, window, () => new Promise(() => {}), FakeWs, () => 0, Option, navigator);
  const post = data => listeners.message.forEach(fn => fn({ data }));
  const fire = t => listeners[t].forEach(fn => fn({}));
  post({ type: 'input', state: { supported: true, enabled: true, available: true, backend: 'libei', reason: null } });
  FakeWs.last.onopen();
  post({ type: 'pads', pads: [{ id: 'v1', name: 'Virtual pad 1' }, { id: 'v2', name: 'Couch' }] });
  const sel = el('pad-target');
  assert.deepEqual(sel.options.map(o => [o.value, o.text]), [['', 'Auto'], ['v1', 'Virtual pad 1'], ['v2', 'Couch'], ['__add__', 'New virtual pad…']]);
  assert.equal(sel.value, '');
  assert.equal(el('pad-fwd').hidden, true, 'hidden until a gamepad shows up');

  const pressed = i => ({ pressed: i === 0, value: i === 0 ? 1 : 0 });
  gamepads = [{ connected: true, mapping: 'standard', buttons: Array.from({ length: 17 }, (_, i) => pressed(i)), axes: [0, 0, 0, 0] }];
  fire('gamepadconnected');
  assert.equal(el('pad-fwd').hidden, false);
  const pads = () => sent.filter(m => m.type === 'gamepad');
  assert.equal(pads().at(-1).buttons.a, true);
  assert.equal('pad' in pads().at(-1), false, 'Auto sends no pad field');

  sel.value = 'v2'; sel.onchange();
  assert.deepEqual([pads().at(-1).buttons.a, 'pad' in pads().at(-1)], [false, false], 'Auto got a neutral state first');
  fire('gamepadconnected');
  assert.deepEqual([pads().at(-1).buttons.a, pads().at(-1).pad], [true, 'v2']);
  assert.equal(state.padTarget, 'v2', 'choice kept in the webview state');

  sel.value = '__add__'; sel.onchange();
  assert.deepEqual(posted.at(-1), { type: 'addPad' });
  assert.equal(sel.value, 'v2', 'the select goes back to the current target');
  post({ type: 'pads', pads: [{ id: 'v1', name: 'Virtual pad 1' }, { id: 'v2', name: 'Couch' }, { id: 'v3', name: 'New' }], select: 'v3' });
  assert.equal(sel.value, 'v3');
  fire('gamepadconnected');
  assert.equal(pads().at(-1).pad, 'v3');
  post({ type: 'pads', pads: [{ id: 'v1', name: 'Virtual pad 1' }] });
  assert.equal(sel.value, '', 'a removed target falls back to Auto');
  post({ type: 'pads', pads: null });
  assert.equal(el('pad-fwd').hidden, true, 'older device: no select');
  gamepads = [];
  fire('gamepaddisconnected');
  return `options Auto / Virtual pad 1 / Couch / New virtual pad…; Auto → no pad field, Couch → pad "v2", New virtual pad… → addPad, removed → Auto, 404 → hidden`;
});

await check('Steam UI navigation: Navigate to… QuickPick, template prompt, plugin panel, back / Quick Access / close menus, 400, 404', async () => {
  let offered;
  ui.quickPick = (items, opts) => { offered = { items, opts }; return items.find(i => i.label === 'Settings'); };
  await run('decky-toolkit.navigate');
  assert.equal(offered.opts.placeHolder, 'Current: /library/home');
  const placeHolder = offered.opts.placeHolder;
  const sections = offered.items.filter(i => i.kind === vscode.QuickPickItemKind.Separator).map(i => i.label);
  assert.deepEqual(sections, ['Official', 'Plugins', 'Menus']);
  assert.deepEqual(offered.items.filter(i => i.kind === undefined).map(i => [i.label, i.description]), [
    ['Library', '/library/home · current'], ['Game details', '/library/app/{appid}'], ['Settings', '/settings'], ['Tender', '/tender'],
    ['Main menu', undefined], ['Quick Access', undefined], ['Quick Access › Notifications', undefined], ['Quick Access › Decky', undefined]]);
  assert.deepEqual(uiDevice.posts.at(-1), { path: '/settings' });
  assert.match(calls.statusMessages.at(-1), /Steam UI at \/settings/);

  let prompt;
  ui.quickPick = items => items.find(i => i.label === 'Game details');
  ui.inputBox = opts => { prompt = opts; return ' 620 '; };
  await run('decky-toolkit.navigate');
  assert.match(prompt.prompt, /Steam app ID/);
  assert.equal(prompt.validateInput('abc'), 'Digits only');
  assert.equal(prompt.validateInput('620'), undefined);
  assert.deepEqual(uiDevice.posts.at(-1), { path: '/library/app/620' });
  ui.inputBox = () => undefined;
  const before = uiDevice.posts.length;
  await run('decky-toolkit.navigate');
  assert.equal(uiDevice.posts.length, before, 'cancelled template prompt sends nothing');

  ui.quickPick = items => items.find(i => i.label === 'Quick Access › Decky');
  await run('decky-toolkit.navigate');
  assert.deepEqual(uiDevice.posts.at(-1), { action: 'quick_access', tab: 'Decky' });

  ui.quickPick = (items, opts) => { offered = { items, opts }; return items.find(i => i.label === 'Tender'); };
  await run('decky-toolkit.openPluginPanel');
  assert.deepEqual(labels(offered.items), ['Decky Toolkit', 'My Plugin', 'Tender']);
  assert.deepEqual(uiDevice.posts.at(-1), { action: 'plugin', plugin: 'Tender' });
  const [row] = await pluginsProvider().getChildren();
  await run('decky-toolkit.openPluginPanel', row);
  assert.deepEqual(uiDevice.posts.at(-1), { action: 'plugin', plugin: 'Decky Toolkit' });
  assert.ok(itemMenu('decky-toolkit.plugins', 'plugin', false).includes('decky-toolkit.openPluginPanel'));

  for (const [cmd, body] of [['decky-toolkit.uiBack', { action: 'back' }], ['decky-toolkit.uiQuickAccess', { action: 'quick_access' }], ['decky-toolkit.uiCloseMenus', { action: 'close_menus' }]]) {
    await run(cmd);
    assert.deepEqual(uiDevice.posts.at(-1), body, cmd);
  }

  let shown;
  ui.error = m => { shown = m; };
  ui.quickPick = items => items.find(i => i.label === 'Game details');
  const realPaths = uiRoutes.official;
  uiRoutes.official = [{ path: '/nowhere/{appid}', title: 'Game details', template: true }];
  ui.inputBox = () => '1';
  await run('decky-toolkit.navigate');
  uiRoutes.official = realPaths;
  assert.equal(shown, 'Decky Toolkit: Steam UI navigation: unknown path /nowhere/1');

  uiDevice.missing = true;
  await run('decky-toolkit.navigate');
  assert.match(lastMessage('warning').m, /update Decky Toolkit on the device \(10\.1\.2\.3\)/);
  await run('decky-toolkit.uiBack');
  assert.match(lastMessage('warning').m, /update Decky Toolkit on the device/);
  uiDevice.missing = false;
  return `sections ${sections.join(' / ')}, placeholder "${placeHolder}", template → /library/app/620, plugin panel, back / quick_access / close_menus, 400 "${shown}", 404 → update`;
});

await check('stats polling stops when the Actions view is hidden', async () => {
  calls.panels[0].dispose();
  const t = tree('decky-toolkit.actions');
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
  assert.equal(calls.context.get('decky-toolkit.connected'), true, 'views stay while the session is unreachable');
  assert.equal(tree('decky-toolkit.actions').view.description, '10.1.2.3 · unreachable');
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
  await run('decky-toolkit.disconnectDevice');
  await settle();
  assert.equal(calls.context.get('decky-toolkit.connected'), false);
  assert.deepEqual(visibleViews(), ['decky-toolkit.devices']);
  const [r] = devicesProvider().getChildren();
  assert.equal(r.description, 'paired');
  assert.equal(r.iconPath.id, 'vm');
  assert.equal(r.contextValue, 'deck.paired');
  assert.equal(r.command.command, 'decky-toolkit.connect');
  assert.deepEqual(itemMenu('decky-toolkit.devices', r.contextValue, true), ['decky-toolkit.connect', 'decky-toolkit.deviceActions']);
  assert.deepEqual(await actionsProvider().getChildren(), []);
  assert.equal(secrets.get(tokenKey), 'fake-token');
  assert.equal(status(), '$(vm) Decky: not connected');
  return `row "${r.label}" — "${r.description}" [$(vm)]`;
});

await check('Connect with a stored token checks /health and connects without pairing', async () => {
  fetched.length = 0;
  await run('decky-toolkit.connect', seedId());
  await settle();
  assert.ok(fetched.includes('/health'));
  assert.ok(!fetched.includes('/pair/request'));
  assert.equal(calls.context.get('decky-toolkit.connected'), true);
  assert.match(calls.statusMessages.at(-1), /Connected to 10\.1\.2\.3/);
  assert.equal(calls.panels.length, 1, 'screen opens only after the first connect of a session');
  await run('decky-toolkit.disconnectDevice');
  return `requests: ${[...new Set(fetched)].join(', ')}`;
});

await check('a rejected token (401) goes straight into pairing', async () => {
  await ctx.secrets.store(tokenKey, 'stale-token');
  await settle();
  fetched.length = 0;
  device.pairQueue = ['approved'];
  await run('decky-toolkit.connect', seedId());
  await settle();
  assert.ok(fetched.includes('/pair/request'));
  assert.equal(secrets.get(tokenKey), 'fake-token');
  assert.equal(calls.context.get('decky-toolkit.connected'), true);
  await run('decky-toolkit.disconnectDevice');
  return `requests: ${fetched.join(', ')}`;
});

await check('a command while disconnected offers to connect instead of running', async () => {
  let offered;
  ui.warning = (m, buttons) => { offered = { m, buttons }; return undefined; };
  const copied = calls.clipboard.length;
  await run('decky-toolkit.copyToken');
  assert.equal(offered.m, 'Decky Toolkit: not connected to a device.');
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
  await run('decky-toolkit.connect', seedId());
  await settle();
  assert.equal(calls.lastError.m, "Can't reach 10.1.2.3 at 10.1.2.3:8765. Is the device on and Decky Toolkit enabled?");
  assert.deepEqual(calls.lastError.buttons, ['Retry', 'Edit device']);
  assert.equal(row.description, 'unreachable');
  assert.equal(row.iconPath.id, 'warning');
  assert.equal(row.iconPath.color.id, 'problemsWarningIcon.foreground');
  assert.ok(!fetched.includes('/pair/request'));
  assert.equal(calls.context.get('decky-toolkit.connected'), true, 'Retry connected once the device answered');
  await run('decky-toolkit.disconnectDevice');
  return `"${calls.lastError.m}" [${calls.lastError.buttons.join(', ')}], row was "${row.description}"`;
});

await check('pairing denied on the device: "Pairing denied" with Try again, which files a new request', async () => {
  await ctx.secrets.delete(tokenKey);
  await settle();
  device.pairRequests = [];
  device.pairQueue = ['pending', 'denied', 'approved'];
  const offered = [];
  ui.warning = (m, buttons) => { offered.push({ m, buttons }); return 'Try again'; };
  await run('decky-toolkit.connect', seedId());
  await settle();
  assert.deepEqual(offered, [{ m: 'Decky Toolkit: Pairing denied on 10.1.2.3.', buttons: ['Try again'] }]);
  assert.equal(device.pairRequests.length, 2, 'Try again filed a second request');
  assert.equal(secrets.get(tokenKey), 'fake-token');
  assert.equal(calls.context.get('decky-toolkit.connected'), true);
  await run('decky-toolkit.disconnectDevice');
  return `"${offered[0].m}" [${offered[0].buttons.join(', ')}], then approved`;
});

await check('pairing has no time limit: survives a lost connection and a forgotten request (new code); Cancel sends DELETE', async () => {
  await ctx.secrets.delete(tokenKey);
  await settle();
  device.pairRequests = [];
  device.pairCancelled = [];
  device.pairQueue = ['pending', 'down', 'pending', 'gone'];
  const warningsBefore = calls.messages.filter(m => m.kind === 'warning').length;
  const done = run('decky-toolkit.connect', seedId());
  for (let i = 0; i < 200 && (device.pairRequests.length < 2 || device.pairQueue.length); i++) await settle(10);
  await settle(60);
  const row = devicesProvider().getChildren()[0];
  const prog = calls.progress.at(-1);
  prog.cancel();
  await done;
  await settle();
  assert.equal(row.description, 'waiting for approval · code 4822', 'the row shows the new code');
  assert.ok(prog.messages.some(m => /^Lost contact with 10\.1\.2\.3 \(cannot reach the device \(socket hang up\)\), retrying… Code 4821\.$/.test(m)));
  assert.equal(prog.messages.at(-1), 'Waiting for approval on 10.1.2.3 · code 4822. On the device: Quick Access → Decky Toolkit → Approve.');
  assert.deepEqual(device.pairCancelled, ['req1']);
  assert.equal(calls.messages.filter(m => m.kind === 'warning').length, warningsBefore, 'cancel is silent');
  assert.equal(calls.context.get('decky-toolkit.connected'), false);
  assert.equal(devicesProvider().getChildren()[0].description, 'not paired');
  return `${prog.messages.length} progress updates, codes 4821 → 4822, DELETE ${device.pairCancelled[0]}`;
});

await check('a device without pairing requests (401): "Update Decky Toolkit" with Enter token manually', async () => {
  device.pairUnsupported = true;
  let offered;
  ui.warning = (m, buttons) => { offered = { m, buttons }; return undefined; };
  await run('decky-toolkit.connect', seedId());
  device.pairUnsupported = false;
  assert.equal(offered.m, 'Decky Toolkit: Update Decky Toolkit on 10.1.2.3 to pair. Until then, copy the token from its Decky Toolkit panel.');
  assert.deepEqual(offered.buttons, ['Enter token manually']);
  assert.equal(devicesProvider().getChildren()[0].description, 'not paired');
  return `"${offered.m}" [${offered.buttons.join(', ')}]`;
});

await check('Add device: host + optional name, port only via "Change port", then offers Connect', async () => {
  const inputs = ['10.9.9.9', '', '9000'];
  const prompts = [];
  ui.inputBox = opts => { prompts.push(opts.prompt); if (opts.validateInput) assert.equal(opts.validateInput(inputs[0]), undefined); return inputs.shift(); };
  const picks = ['port', 'later'];
  const offered = [];
  ui.quickPick = items => { offered.push(items.map(i => i.label)); const want = picks.shift(); return items.find(i => i.id === want); };
  await run('decky-toolkit.addDevice');
  await settle();
  const d = globalState.get('decky-toolkit.devices')[1];
  assert.deepEqual({ name: d.name, host: d.host, port: d.port }, { name: '10.9.9.9', host: '10.9.9.9', port: 9000 });
  assert.equal(prompts.length, 3);
  assert.match(offered[0][0], /Connect to 10\.9\.9\.9/);
  assert.match(offered[0][1], /Change port \(8765\)/);
  ui.inputBox = opts => opts.validateInput('http://x/');
  await run('decky-toolkit.refresh');
  await settle();
  const rows = devicesProvider().getChildren();
  assert.equal(rows[1].label, '10.9.9.9:9000');
  assert.equal(rows[1].description, 'unreachable', 'refresh probes saved devices');
  return `prompts: ${prompts.join(' / ')}; then picks ${offered[0].join(' | ')}`;
});

await check('status bar QuickPick: connect/switch, disconnect, open screen, add', async () => {
  await ctx.secrets.store(tokenKey, 'fake-token');
  await run('decky-toolkit.connect', seedId());
  await settle();
  let offered;
  ui.quickPick = (items, opts) => { offered = { labels: items.map(i => i.label), placeHolder: opts.placeHolder }; return undefined; };
  await run('decky-toolkit.switchDevice');
  assert.equal(calls.statusItems[0].command ?? 'decky-toolkit.switchDevice', 'decky-toolkit.switchDevice');
  assert.equal(offered.placeHolder, 'Connected to 10.1.2.3');
  assert.deepEqual(offered.labels, [
    '$(vm-connect) 10.1.2.3', '$(warning) 10.9.9.9', '', '$(debug-disconnect) Disconnect from 10.1.2.3', '$(device-desktop) Open screen', '$(add) Add device…']);
  assert.equal(calls.statusItems[0].tooltip, 'Decky: connected to 10.1.2.3 (10.1.2.3:8765). Click for devices');
  return offered.labels.filter(Boolean).join(' | ');
});

await check('Copy viewer URL and the … overflow menu', async () => {
  await run('decky-toolkit.copyViewerUrl', seedId());
  assert.equal(calls.clipboard.at(-1), 'http://10.1.2.3:8765/viewer');
  let offered;
  ui.quickPick = items => { offered = items.map(i => i.label); };
  await run('decky-toolkit.deviceActions', seedId());
  assert.deepEqual(offered.map(l => l.replace(/^\$\([^)]+\) /, '')), ['Re-pair', 'Enter token manually', 'Edit', 'Copy viewer URL', 'Remove']);
  return offered.join(' | ');
});

await check('browser viewer (static/viewer.html): Controllers popover, live updates, add / refusal, 404 hides it', async () => {
  const html = readFileSync(path.join(root, '..', 'static', 'viewer.html'), 'utf8');
  const src = html.match(/<script>([\s\S]*)<\/script>/)[1];
  for (const id of ['ctl-wrap', 'ctl-btn', 'ctl-pop', 'ctl-list', 'ctl-add', 'ctl-name', 'pad-fwd', 'pad-target']) assert.ok(html.includes(`id="${id}"`), id);
  const els = new Map();
  const mk = (tag = 'div') => {
    const classes = new Set();
    const listeners = {};
    return {
      tag, textContent: '', hidden: false, value: '', disabled: false, title: '', placeholder: '', className: '', children: [], options: [],
      append(...c) { this.children.push(...c); }, replaceChildren(...c) { this.children = [...c]; if (this.tag === 'select') this.options = [...c]; },
      addEventListener(t, fn) { (listeners[t] ??= []).push(fn); }, setAttribute() {}, focus() {},
      classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c), toggle: (c, on) => ((on ?? !classes.has(c)) ? classes.add(c) : classes.delete(c), classes.has(c)) },
      _listeners: listeners,
    };
  };
  const initiallyHidden = ['ctl-wrap', 'ctl-pop', 'pad-fwd', 'pad-ind', 'input-ctl', 'settings', 'pop', 'audio-ctl', 'a-hint', 'a-stat'];
  const el = id => { if (!els.has(id)) { const e = mk(id === 'pad-target' ? 'select' : 'div'); e.hidden = initiallyHidden.includes(id); els.set(id, e); } return els.get(id); };
  const document = { getElementById: el, createElement: mk, querySelectorAll: () => [], addEventListener() {}, hasFocus: () => true, hidden: false, activeElement: null };
  class Option { constructor(text, value) { this.text = text; this.value = value; } }
  const dev = { missing: false, refuse: null, list: { controllers: [steamDeck], virtual: [{ id: 'auto0', name: 'Decky Toolkit pad', auto: true }], input_enabled: false } };
  const requests = [];
  const reply = (b, status = 200) => ({ ok: status < 400, status, json: async () => b, text: async () => JSON.stringify(b) });
  const viewerFetch = async (url, init = {}) => {
    requests.push(`${init.method ?? 'GET'} ${url}`);
    if (url.startsWith('/controllers') && dev.missing) return reply({}, 404);
    if (url === '/controllers') return reply(dev.list);
    if (url === '/controllers/virtual') {
      if (dev.refuse) return reply({ error: dev.refuse }, 422);
      const { name } = JSON.parse(init.body);
      dev.list.virtual.push({ id: 'v1', name, auto: false });
      return reply({ id: 'v1', name, type: 'x360' }, 201);
    }
    return new Promise(() => {});
  };
  const sources = [];
  class EventSource { constructor(u) { this.u = u; sources.push(this); } close() { this.closed = true; } }
  new Function('document', 'window', 'fetch', 'EventSource', 'Option', 'localStorage', 'navigator', 'WebSocket', 'requestAnimationFrame', src)(
    document, { addEventListener() {}, open() {}, EventSource }, viewerFetch, EventSource, Option, { getItem: () => null, setItem() {} }, {}, class {}, () => 0);
  await settle(10);
  assert.equal(el('ctl-wrap').hidden, false, 'button shown when /controllers answers');
  el('ctl-btn').onclick({ stopPropagation() {} });
  await settle(10);
  assert.equal(el('ctl-pop').hidden, false);
  assert.deepEqual(sources.map(s => s.u), ['/controllers/events'], 'live while open');
  const rowText = () => el('ctl-list').children.filter(r => r.className.startsWith('ctl-row')).map(r => r.children[0].children.map(c => c.textContent).join(' | '));
  assert.deepEqual(rowText(), ['1. Steam Deck | physical · Steam Input: steamdeck · Slot 1', '🎮 Decky Toolkit pad (virtual) | virtual · not seen by Steam Input · auto']);
  assert.equal(el('ctl-name').placeholder, 'Virtual pad 1');
  await el('ctl-add').onsubmit({ preventDefault() {} });
  assert.ok(requests.includes('POST /controllers/virtual'));
  assert.equal(el('ctl-note').textContent, 'Virtual controller added and recognised by Steam Input');
  assert.deepEqual(el('pad-target').options.map(o => o.text), ['Auto', 'Virtual pad 1', 'New virtual pad…'], '"Forward to" follows the list');
  sources[0].onmessage({ data: JSON.stringify({ type: 'controllers', controllers: [], virtual: [] }) });
  assert.deepEqual(rowText(), [], 'SSE update applied');
  assert.equal(el('ctl-list').children[0].textContent, 'No controllers seen by Steam Input.');
  dev.refuse = 'Steam Input did not pick up the new pad';
  await el('ctl-add').onsubmit({ preventDefault() {} });
  assert.equal(el('ctl-note').textContent, 'Steam Input did not pick up the new pad', 'refusal shown as-is');
  sources[0].onerror();
  assert.equal(sources[0].closed, true, 'stream failure → poll');
  el('ctl-btn').onclick({ stopPropagation() {} });
  assert.equal(el('ctl-pop').hidden, true);
  dev.missing = true;
  await el('pad-target')._listeners.focus[0]();
  assert.equal(el('ctl-wrap').hidden, true, '404 hides the button');
  assert.equal(el('pad-fwd').hidden, true, '404 hides "Forward to"');
  return requests.filter(r => r.includes('controllers')).join(', ');
});

await check('Games view with fake clients: Proton title with saves, native title, shortcut, 404 device, errors', async () => {
  const device = { id: 'g', name: 'Deck', host: '10.0.70.18', port: 8765 };
  const fakeConn = client => ({ connectedDevice: device, authedClient: () => client, onDidChangeTarget: new EventEmitter().event, label: 'Deck' });
  const listings = {
    [`${CT_USER}/AppData/Local/ChainedTogether/Saved/SaveGames`]: [
      { path: 'Save.sav', type: 'file', size: 2348, mtime: ago(20000) }, { path: 'Backup', type: 'dir', size: 0, mtime: ago(20000) },
      { path: 'Progress.sav', type: 'file', size: 30519, mtime: ago(3650) }, { path: 'notes.txt', type: 'file', size: 12, mtime: ago(20000) },
    ],
  };
  const fsCalls = [];
  const client = {
    apps: async () => ({ count: games.apps.length, apps: games.apps }),
    appDirs: async id => { if (!games.dirs[id]) throw new Error('app 4289220546 has no folders'); return games.dirs[id]; },
    appSaves: async id => { if (id === 4289220546) throw new Error('Steam is busy'); return games.saves[id]; },
    fsList: async p => { fsCalls.push(p); return { path: p, depth: 1, glob: null, entries: listings[p] ?? [], count: 0, truncated: false }; },
  };
  const tree = new ext.GamesTreeProvider(fakeConn(client));
  const rows = await tree.getChildren();
  assert.deepEqual(rows.map(r => [r.label, r.description, r.iconPath.id, r.contextValue, r.collapsibleState]), [
    ['VVVVVV', 'Linux runtime · running', 'play-circle', 'game.running', 1],
    ['Chained Together', 'Proton 11', 'game', 'game', 1],
    ['1080° Avalanche', 'native', 'game', 'game', 1],
  ], 'installed only, last played first');
  const inline = r => itemMenu('decky-toolkit.games', r.contextValue, true);
  assert.deepEqual(rows.map(inline), [
    ['decky-toolkit.gameTerminate', 'decky-toolkit.openGameSaves'], ['decky-toolkit.gameLaunch', 'decky-toolkit.openGameSaves'], ['decky-toolkit.gameLaunch', 'decky-toolkit.openGameSaves']]);
  assert.deepEqual(itemMenu('decky-toolkit.games', 'game', false),
    ['decky-toolkit.openGameSaves', 'decky-toolkit.gameLaunch', 'decky-toolkit.gameProtonLog', 'decky-toolkit.copyDeckyPath']);
  assert.match(rows[1].tooltip.value, /Proton 11\.0-2/);

  const proton = await tree.getChildren(rows[1]);
  assert.deepEqual(proton.map(c => [c.label, c.description]), [
    ['Save data', '3 files'], ['Install folder', '~/.local/share/Steam/steamapps/common/ChainedTogether'], ['Proton prefix', 'Proton 11'],
    ['Steam Cloud (userdata)', 'userdata/95599472/2567870'], ['Shader cache', undefined], ['Proton log', undefined]]);
  const [saveGroup, install, prefix, , , log] = proton;
  assert.equal(saveGroup.collapsibleState, 2, 'Save data starts expanded');
  assert.deepEqual(log.command, { command: 'decky-toolkit.gameProtonLog', title: 'Show log', arguments: [rows[1]] });
  assert.equal(install.resourceUri.toString(), `decky://10.0.70.18${STEAM}/steamapps/common/ChainedTogether`);
  assert.deepEqual(itemMenu('decky-toolkit.games', install.contextValue, true), ['decky-toolkit.openInExplorer']);
  assert.deepEqual(itemMenu('decky-toolkit.games', install.contextValue, false), ['decky-toolkit.openInExplorer', 'decky-toolkit.copyDeckyPath']);
  const locs = await tree.getChildren(saveGroup);
  assert.deepEqual(locs.map(l => [l.label, l.description, l.iconPath.id, l.collapsibleState]), [
    ['AppData/Local/ChainedTogether/Saved/SaveGames', '2 saves · 1 h ago', 'cloud', 2],
    ['AppData/Local/ChainedTogether/Saved/Config/Windows', '1 save · 5 h ago', 'folder', 1]]);
  assert.equal(locs[0].explorerName, 'Chained Together saves');
  const files = await tree.getChildren(locs[0]);
  assert.deepEqual(files.map(f => [f.label, f.contextValue, f.iconPath.id, f.description]), [
    ['Backup', 'deckyDir', 'folder', undefined], ['notes.txt', 'deckyFile', 'file', '12 B · 5 h ago'],
    ['Progress.sav', 'deckyFile', 'save', '30 KB · 1 h ago'], ['Save.sav', 'deckyFile', 'save', '2.3 KB · 5 h ago']], 'folders first, saves marked');
  assert.deepEqual(files[2].command, { command: 'vscode.open', title: 'Open', arguments: [files[2].resourceUri] });
  assert.equal(files[2].resourceUri.toString(), `decky://10.0.70.18${CT_USER}/AppData/Local/ChainedTogether/Saved/SaveGames/Progress.sav`);
  assert.equal(tree.getParent(files[2]), locs[0]);
  assert.equal(tree.getParent(rows[1]), undefined);
  assert.deepEqual((await tree.getChildren(files[0])).map(e => e.label), ['Empty folder']);
  const shortcuts = await tree.getChildren(prefix);
  assert.deepEqual(shortcuts.map(s => [s.label, s.description]), [
    ['AppData/Local', 'ChainedTogether'], ['AppData/Roaming', undefined], ['Documents', undefined], ['Saved Games', undefined], ['drive_c', undefined]]);
  assert.equal(shortcuts[0].devicePath, `${CT_USER}/AppData/Local`);
  assert.equal(prefix.devicePath, CT_USER);

  const native = await tree.getChildren(rows[0]);
  assert.deepEqual(native.map(c => [c.label, c.description]), [
    ['Save data', '3 files'], ['Game data', '~/.local/share/VVVVVV'], ['Install folder', '~/.local/share/Steam/steamapps/common/vvvvvv'],
    ['Steam Cloud (userdata)', 'userdata/95599472/70300'], ['Shader cache', undefined], ['Launch log', undefined]], 'no prefix for a native title');
  const nativeLocs = await tree.getChildren(native[0]);
  assert.deepEqual(nativeLocs.map(l => [l.label, l.description]), [['~/.local/share/VVVVVV/saves', '3 saves · 5 min ago']]);

  const rom = await tree.getChildren(rows[2]);
  assert.deepEqual(rom.map(c => [c.label, c.description]), [
    ['Save data', 'unavailable'], ['Could not load folders: app 4289220546 has no folders', undefined], ['Launch log', undefined]]);
  assert.deepEqual((await tree.getChildren(rom[0])).map(c => c.label), ['Could not load saves: Steam is busy']);

  const old = new ext.GamesTreeProvider(fakeConn({ apps: async () => { throw new ext.HttpError(404, '404: Not Found', '/apps'); } }));
  const [o] = await old.getChildren();
  assert.deepEqual([o.label, o.description, o.contextValue], ['Games', 'update Decky Toolkit on the device', 'game.unsupported']);
  assert.deepEqual(itemMenu('decky-toolkit.games', o.contextValue, true), []);
  let fail = true;
  const flaky = new ext.GamesTreeProvider(fakeConn({ apps: async () => { if (fail) throw new Error('boom'); return { count: 0, apps: [] }; } }));
  const [e] = await flaky.getChildren();
  assert.equal(e.label, 'Could not load games: boom');
  assert.equal(e.command.command, 'decky-toolkit.refreshGames');
  fail = false;
  assert.deepEqual(labels(await flaky.getChildren()), ['No installed games'], 'an error is not cached');
  const unpaired = new ext.GamesTreeProvider({ ...fakeConn(undefined), connectedDevice: undefined });
  assert.deepEqual(await unpaired.getChildren(), []);
  return `${rows.map(r => `${r.label} — ${r.description}`).join(' | ')}; Proton children ${proton.map(c => c.label).join(', ')}`;
});

await check('Find game QuickPick builder and labels', async () => {
  const now = Date.now();
  const picks = ext.buildGamePicks(games.apps, now);
  assert.deepEqual(picks.map(p => [p.label, p.description, p.detail]), [
    ['$(play-circle) VVVVVV', 'Linux runtime', '70300 · running · 72 MB'],
    ['$(game) Chained Together', 'Proton 11', '2567870 · played 1 h ago · 7.9 GB'],
    ['$(game) 1080° Avalanche', 'native · non-Steam', '4289220546 · never played'],
  ]);
  assert.equal(picks[1].app.appid, 2567870);
  const many = Array.from({ length: 124 }, (_, i) => ({ ...appRom, appid: i + 1, name: `ROM ${i}`, last_played: i % 3 ? ago(i * 100) : null }));
  const big = ext.buildGamePicks(many, now);
  assert.equal(big.length, 124);
  assert.deepEqual(big.slice(0, 2).map(p => p.label), ['$(game) ROM 1', '$(game) ROM 2']);
  assert.equal(big.at(-1).detail.endsWith('never played'), true);
  assert.deepEqual(['proton_experimental', 'proton_9', 'steamlinuxruntime', 'GE-Proton9-20', null].map(t => ext.runtimeLabel({ compat_tool: t, compat_tool_display: t === 'GE-Proton9-20' ? 'GE-Proton9-20' : null })),
    ['Proton Experimental', 'Proton 9', 'Linux runtime', 'GE-Proton9-20', 'native']);
  assert.deepEqual([0, 1023, 2048, 30519, 8493964009].map(ext.formatSize), ['0 B', '1023 B', '2.0 KB', '30 KB', '7.9 GB']);
  assert.equal(ext.bestSaveFolder(savesVVVVVV, dirsVVVVVV), '/home/jackh/.local/share/VVVVVV/saves');
  assert.equal(ext.bestSaveFolder({ ...savesChained, candidates: [] }, dirsChained), `${CT_USER}/AppData/Local/ChainedTogether`);
  assert.equal(ext.bestSaveFolder({ ...savesVVVVVV, candidates: [] }, dirsVVVVVV), '/home/jackh/.local/share/VVVVVV');
  return picks.map(p => `${p.label} — ${p.description} — ${p.detail}`).join(' | ');
});

await check('Games commands: Find game reveals, Open save data adds a decky:// workspace folder, launch / terminate (confirm) / Proton log', async () => {
  await run('decky-toolkit.connect', seedId());
  await settle();
  run('decky-toolkit.refreshGames');
  let offered;
  ui.quickPick = (items, opts) => { offered = { items, opts }; return items.find(i => i.label.includes('VVVVVV')); };
  await run('decky-toolkit.findGame');
  assert.equal(offered.opts.matchOnDescription, true);
  assert.deepEqual(offered.items.map(i => i.label), ['$(play-circle) VVVVVV', '$(game) Chained Together', '$(game) 1080° Avalanche']);
  const rev = calls.revealed.at(-1);
  assert.equal(rev.id, 'decky-toolkit.games');
  assert.equal(rev.node.app.appid, 70300);
  assert.deepEqual(rev.opts, { select: true, focus: true, expand: true });

  await run('decky-toolkit.openGameSaves');
  assert.deepEqual(calls.folderUpdates.map(f => [f.start, f.deleteCount, f.folders.map(x => [x.uri.toString(), x.name])]), [
    [0, 0, [['decky://10.1.2.3/home/jackh/.local/share/VVVVVV/saves', 'VVVVVV saves (10.1.2.3)']]]]);
  const gameRow = (await tree('decky-toolkit.games').provider.getChildren()).find(r => r.app?.appid === 2567870);
  await run('decky-toolkit.openGameSaves', gameRow);
  assert.equal(calls.folderUpdates.at(-1).folders[0].uri.toString(), `decky://10.1.2.3${CT_USER}/AppData/Local/ChainedTogether/Saved/SaveGames`);
  assert.equal(calls.folderUpdates.at(-1).folders[0].name, 'Chained Together saves (10.1.2.3)');

  await run('decky-toolkit.gameLaunch', gameRow);
  assert.deepEqual(games.toolCalls.at(-1), { name: 'app_launch', arguments: { appid: 2567870 } });
  assert.match(lastMessage('info').m, /Chained Together is running/);

  const vRow = (await tree('decky-toolkit.games').provider.getChildren()).find(r => r.app?.appid === 70300);
  const before = games.toolCalls.length;
  ui.warning = () => undefined;
  await run('decky-toolkit.gameTerminate', vRow);
  assert.equal(games.toolCalls.length, before, 'cancelled confirm sends nothing');
  assert.match(lastMessage('warning').m, /Terminate VVVVVV on/);
  ui.warning = (_m, buttons) => buttons[0];
  await run('decky-toolkit.gameTerminate', vRow);
  assert.deepEqual(games.toolCalls.at(-1), { name: 'app_terminate', arguments: { appid: 70300, confirm: true } });

  await run('decky-toolkit.gameProtonLog', gameRow);
  const doc = calls.docs.at(-1).doc;
  assert.equal(doc.language, 'log');
  assert.match(doc.content, /^# Chained Together \(2567870\) on /);
  assert.match(doc.content, /PROTON_LOG=1/);
  assert.match(doc.content, /StartSession: appID 2567870/);

  ui.inputBox = () => '~/.local/share/VVVVVV/saves/tsave.vvv';
  const opened = [];
  const realExec = vscode.commands.executeCommand;
  vscode.commands.executeCommand = async (id, ...args) => { opened.push([id, ...args.map(String)]); return realExec(id, ...args); };
  try {
    await run('decky-toolkit.openDeckyPath');
    assert.deepEqual(opened.at(-1), ['vscode.open', 'decky://10.1.2.3/home/jackh/.local/share/VVVVVV/saves/tsave.vvv']);
    ui.inputBox = () => '/home/jackh/.local/share/VVVVVV/current/';
    await run('decky-toolkit.openDeckyPath');
    assert.equal(calls.folderUpdates.at(-1).folders[0].uri.toString(), 'decky://10.1.2.3/home/jackh/.local/share/VVVVVV/current', 'symlink to a folder opens as a folder');
  } finally {
    vscode.commands.executeCommand = realExec;
  }
  await run('decky-toolkit.copyDeckyPath', gameRow);
  assert.equal(calls.clipboard.at(-1), `${STEAM}/steamapps/common/ChainedTogether`);
  return `revealed ${rev.node.label}; folders ${calls.folderUpdates.map(f => f.folders[0].name).join(', ')}; tools ${games.toolCalls.map(t => t.name).join(', ')}`;
});

await check('remote FS provider against a fake /fs* server: stat, readDirectory, read/write round trip, mkdir, rename, delete (confirm), errors', async () => {
  const devices = [
    { id: 'd1', name: 'Deck', host: '10.1.2.3', port: 8765 },
    { id: 'd2', name: 'Gone', host: '10.9.9.9', port: 8765 },
    { id: 'd3', name: 'Fresh', host: '10.1.2.4', port: 8765 },
  ];
  const fs = new ext.DeckyFileSystemProvider({ devices, tokenFor: async d => (d.host === '10.1.2.4' ? undefined : 'fake-token') });
  const events = [];
  fs.onDidChangeFile(e => events.push(...e.map(x => [x.type, x.uri.path])));
  const U = p => ext.deckyUri({ host: '10.1.2.3', port: 8765 }, p);
  const code = async p => { try { await p; } catch (e) { assert.ok(e instanceof vscode.FileSystemError, String(e)); return [e.code, e.message]; } assert.fail('expected an error'); };
  const dec = b => new TextDecoder().decode(b);
  const VV = '/home/jackh/.local/share/VVVVVV';

  assert.equal(ext.deckyUri({ host: '10.1.2.3', port: 9000 }, '/x').toString(), 'decky://10.1.2.3:9000/x');
  assert.equal(ext.globEscape('a[1]*?.sav'), 'a[[]1][*][?].sav');
  assert.equal((await fs.stat(U('/'))).type, vscode.FileType.Directory);
  assert.deepEqual(await fs.stat(U(`${VV}/saves`)), { type: 2, size: 0, mtime: Date.parse('2026-11-04T09:35:42+00:00'), ctime: Date.parse('2026-11-04T09:35:42+00:00') });
  assert.deepEqual([(await fs.stat(U(`${VV}/saves/tsave.vvv`))).type, (await fs.stat(U(`${VV}/saves/tsave.vvv`))).size], [1, 7]);
  assert.equal((await fs.stat(U(`${VV}/current`))).type, 64 | 2, 'symlink to a dir');
  assert.deepEqual(await code(fs.stat(U(`${VV}/nope`))), ['FileNotFound', `decky://10.1.2.3${VV}/nope`]);
  assert.ok(fakeFs.log.includes(`GET /fs?path=${encodeURIComponent(`${VV}/saves`)}&glob=tsave.vvv`), 'stat lists the parent with an exact glob');

  assert.deepEqual(await fs.readDirectory(U(VV)), [['saves', 2], ['current', 64 | 2]]);
  assert.deepEqual(await fs.readDirectory(U(`${VV}/saves`)), [['tsave.vvv', 1], ['unlock.vvv', 1]]);
  const n = fakeFs.log.length;
  await fs.stat(U(`${VV}/saves/unlock.vvv`));
  assert.equal(fakeFs.log.length, n, 'stat right after readDirectory uses the listing');
  assert.equal(dec(await fs.readFile(U(`${VV}/saves/tsave.vvv`))), '<Save/>');

  await fs.writeFile(U(`${VV}/saves/new/edited.vvv`), new TextEncoder().encode('v1'), { create: true, overwrite: true });
  assert.equal(dec(await fs.readFile(U(`${VV}/saves/new/edited.vvv`))), 'v1');
  await fs.writeFile(U(`${VV}/saves/new/edited.vvv`), new TextEncoder().encode('v2 ✓'), { create: false, overwrite: true });
  assert.equal(dec(await fs.readFile(U(`${VV}/saves/new/edited.vvv`))), 'v2 ✓', 'round trip keeps UTF-8 bytes');
  assert.equal((await fs.stat(U(`${VV}/saves/new/edited.vvv`))).size, 6, 'stat after a write is not served from a stale listing');
  assert.deepEqual((await code(fs.writeFile(U(`${VV}/saves/x.vvv`), new Uint8Array(1), { create: false, overwrite: true })))[0], 'FileNotFound');
  assert.deepEqual((await code(fs.writeFile(U(`${VV}/saves/tsave.vvv`), new Uint8Array(1), { create: true, overwrite: false })))[0], 'FileExists');
  assert.deepEqual((await code(fs.readFile(U(`${VV}/saves`))))[0], 'FileIsADirectory');

  await fs.createDirectory(U(`${VV}/saves/slot2`));
  assert.deepEqual((await code(fs.createDirectory(U(`${VV}/saves/slot2`))))[0], 'FileExists');
  await fs.rename(U(`${VV}/saves/new/edited.vvv`), U(`${VV}/saves/slot2/edited.vvv`), { overwrite: false });
  assert.equal(dec(await fs.readFile(U(`${VV}/saves/slot2/edited.vvv`))), 'v2 ✓');
  assert.deepEqual((await code(fs.rename(U(`${VV}/saves/slot2/edited.vvv`), U(`${VV}/saves/tsave.vvv`), { overwrite: false })))[0], 'FileExists');
  assert.deepEqual((await code(fs.rename(U(`${VV}/saves/tsave.vvv`), ext.deckyUri({ host: '10.9.9.9', port: 8765 }, '/x'), { overwrite: false })))[0], 'NoPermissions');

  const raw = await fetch(`http://10.1.2.3:8765/fs?path=${encodeURIComponent(`${VV}/saves/slot2`)}`, { method: 'DELETE', headers: { Authorization: 'Bearer fake-token' } });
  assert.equal(raw.status, 400, 'the fake server refuses a delete without confirm');
  await fs.delete(U(`${VV}/saves/slot2`), { recursive: true });
  assert.ok(fakeFs.log.includes(`DELETE /fs?path=${encodeURIComponent(`${VV}/saves/slot2`)}&confirm=1`), 'delete sends confirm=1');
  assert.deepEqual((await code(fs.stat(U(`${VV}/saves/slot2`))))[0], 'FileNotFound');
  assert.deepEqual(events, [
    [2, `${VV}/saves/new/edited.vvv`], [1, `${VV}/saves/new/edited.vvv`], [2, `${VV}/saves/slot2`],
    [3, `${VV}/saves/new/edited.vvv`], [2, `${VV}/saves/slot2/edited.vvv`], [3, `${VV}/saves/slot2`]]);

  const login = '/home/jackh/.local/share/Steam/config/loginusers.vdf';
  assert.deepEqual(await code(fs.readFile(U(login))), ['NoPermissions', `refused: ${login} holds Steam login credentials`]);
  assert.deepEqual((await code(fs.writeFile(U(login), new Uint8Array(1), { create: true, overwrite: true })))[0], 'NoPermissions');
  assert.deepEqual(await code(fs.writeFile(U('/home/jackh/.bashrc'), new Uint8Array(1), { create: true, overwrite: true })),
    ['NoPermissions', 'refused: /home/jackh/.bashrc is not inside a game install dir']);
  assert.deepEqual((await code(fs.delete(U(`${VV}/saves/nope`), { recursive: false })))[0], 'FileNotFound');

  const [unreach, msg] = await code(fs.stat(ext.deckyUri({ host: '10.9.9.9', port: 8765 }, '/home')));
  assert.equal(unreach, 'Unavailable');
  assert.match(msg, /Decky device Gone is not reachable \(cannot reach the device/);
  assert.deepEqual(await code(fs.readFile(ext.deckyUri({ host: '10.1.2.4', port: 8765 }, '/x'))),
    ['Unavailable', 'not paired with Decky device Fresh; connect to it in the Decky view']);
  assert.deepEqual(await code(fs.readDirectory(ext.deckyUri({ host: '10.5.5.5', port: 8765 }, '/'))),
    ['Unavailable', 'no saved Decky device 10.5.5.5; add it in the Decky view']);
  fakeFs.missing = true;
  try {
    assert.deepEqual(await code(fs.readFile(U(`${VV}/saves/tsave.vvv`))),
      ['Unavailable', 'the Decky Toolkit plugin on Deck has no remote file access yet; update it']);
  } finally {
    fakeFs.missing = false;
  }
  return `${fakeFs.log.length} /fs requests; events ${events.length}; errors map to FileNotFound / FileExists / FileIsADirectory / NoPermissions / Unavailable`;
});

await check('no unexpected error messages', async () => {
  assert.deepEqual(calls.unexpectedErrors, []);
});

for (const d of ctx.subscriptions) d.dispose?.();
ext.deactivate();
const failed = results.filter(r => !r).length;
console.log(failed ? `\n${failed} check(s) failed` : `\nall ${results.length} smoke checks passed`);
process.exit(failed ? 1 : 0);
