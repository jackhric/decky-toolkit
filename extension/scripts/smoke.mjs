// Activation smoke test against a stub `vscode` module; needs no device and no VS Code.
// Usage: node scripts/smoke.mjs
import * as esbuild from 'esbuild';
import assert from 'assert/strict';
import Module, { createRequire } from 'module';
import { execFileSync } from 'child_process';
import { X509Certificate, createHash, createPublicKey, generateKeyPairSync } from 'crypto';
import * as http from 'http';
import * as https from 'https';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'fs';
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
      "export * from './src/controllers'; export * from './src/navigation'; export { DeckyClient, HttpError } from './src/client'; " +
      "export * from './src/games'; export * from './src/remoteFs'; export * from './src/discovery'; export * from './src/transport'; " +
      "export { pairingCode } from './src/pairing'; export { DeviceProxy } from './src/proxy';",
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

// Throwaway device identity: a self-signed CA/server certificate and a client certificate it signed, as the
// plugin mints them; `other` is an unrelated self-signed certificate (a reset device).
const certDir = mkdtempSync(path.join(tmpdir(), 'decky-smoke-certs-'));
const ossl = (...args) => execFileSync('openssl', args, { cwd: certDir, stdio: ['ignore', 'pipe', 'pipe'] });
function selfSigned(name) {
  ossl('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.crt`,
    '-days', '2', '-subj', '/CN=Decky Toolkit', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,digitalSignature,keyCertSign');
  return { key: readFileSync(path.join(certDir, `${name}.key`), 'utf8'), cert: readFileSync(path.join(certDir, `${name}.crt`), 'utf8') };
}
const serverPki = selfSigned('server');
const otherPki = selfSigned('other');
const clientKeys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const clientKeyPem = clientKeys.privateKey.export({ type: 'pkcs8', format: 'pem' });
writeFileSync(path.join(certDir, 'client.key'), clientKeyPem);
writeFileSync(path.join(certDir, 'client.ext'), 'extendedKeyUsage=clientAuth\nkeyUsage=digitalSignature\n');
ossl('req', '-new', '-key', 'client.key', '-subj', '/CN=VS Code on smoke', '-out', 'client.csr');
ossl('x509', '-req', '-in', 'client.csr', '-CA', 'server.crt', '-CAkey', 'server.key', '-CAcreateserial', '-days', '2', '-extfile', 'client.ext', '-out', 'client.crt');
const clientCertPem = readFileSync(path.join(certDir, 'client.crt'), 'utf8');
const peerOf = pem => { const x = new X509Certificate(pem); return { der: x.raw, pem, fingerprint256: x.fingerprint256 }; };
const serverPeer = peerOf(serverPki.cert);
const deviceCode = (publicKeyPem, id) => {
  const spki = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  const d = createHash('sha256').update(Buffer.concat([serverPeer.der, spki, Buffer.from(id)])).digest();
  return String(d.readUInt32BE(0) % 10000).padStart(4, '0');
};
// What a completed pairing stores; the fake device accepts requests that present this client certificate.
const pairedIdentity = { key: clientKeyPem, cert: clientCertPem, serverCert: serverPki.cert };

class TabInputWebview { constructor(viewType) { this.viewType = viewType; } }
// A screen tab left behind by an earlier extension host (VS Code prefixes the view type).
const orphanGroup = { viewColumn: 2, isActive: false, tabs: [] };
orphanGroup.tabs.push({ group: orphanGroup, isActive: true, input: new TabInputWebview('mainThreadWebview-decky-toolkit.screen') });
const tabGroups = [orphanGroup];

const calls = {
  treeViews: [], treeProviders: [], webviewProviders: [], commands: new Map(), context: new Map(), statusItems: [], executed: [],
  panels: [], closedTabs: [], progress: [], messages: [], statusMessages: [], clipboard: [], unexpectedErrors: [], opened: [], written: [], saveDialogs: [],
  watchers: [], output: [], fsProviders: [], folderUpdates: [], docs: [], revealed: [], decorations: [], channels: new Map(),
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
class FileDecoration { constructor(badge, tooltip, color) { this.badge = badge; this.tooltip = tooltip; this.color = color; } }
class MarkdownString { value = ''; appendMarkdown(s) { this.value += s; return this; } }
class RelativePattern { constructor(base, pattern) { this.base = base; this.pattern = pattern; } }
const Uri = {
  parse: s => ({ toString: () => s, path: new URL(s).pathname }),
  file: p => ({ toString: () => `file://${p}`, path: p, fsPath: p }),
  joinPath: (u, ...p) => ({ toString: () => [u.toString(), ...p].join('/'), path: [u.path ?? '', ...p].join('/'), fsPath: [u.fsPath ?? u.path ?? '', ...p].join('/') }),
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
  const options = rest.find(r => r && typeof r === 'object');
  calls.messages.push({ kind, m, buttons, ...(options ? { options } : {}) });
  return ui[kind](m, buttons);
};

// Discovery starts off so the older checks see only saved rows; the discovery checks turn it on.
const settings = { host: '10.1.2.3', port: 8765, pluginDirName: '', 'deploy.build': 'never', 'discovery.enabled': false };
const configEmitter = new EventEmitter();
const workspaceFolders = new EventEmitter();
const noop = async () => undefined;
const noopEvent = () => new Disposable();
const vscode = {
  EventEmitter, Disposable, TreeItem, ThemeIcon, ThemeColor, MarkdownString, Uri, RelativePattern, FileDecoration,
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
  TabInputWebview,
  window: {
    tabGroups: { all: tabGroups, close: async tab => { calls.closedTabs.push(tab); for (const g of tabGroups) g.tabs = g.tabs.filter(t => t !== tab); return true; } },
    createStatusBarItem: () => {
      const item = { text: '', tooltip: '', visible: false, show() { this.visible = true; }, hide() { this.visible = false; }, dispose() { this.visible = false; } };
      calls.statusItems.push(item);
      return item;
    },
    createOutputChannel: name => {
      const lines = [];
      calls.channels.set(name, lines);
      return {
        name, appendLine: l => { lines.push(l); if (name === 'Decky') calls.output.push(l + '\n'); }, append: t => { if (name === 'Decky') calls.output.push(t); }, show() {}, dispose() {},
      };
    },
    createTreeView: (id, opts) => {
      const visibility = new EventEmitter();
      const view = {
        id, visible: true, title: undefined, description: undefined, onDidChangeVisibility: visibility.event, dispose() {}, _visibility: visibility,
        reveal: async (node, opts) => { calls.revealed.push({ id, node, opts }); },
      };
      calls.treeViews.push({ id, provider: opts.treeDataProvider, view });
      return view;
    },
    createWebviewPanel: (viewType, title, where) => {
      const dispose = new EventEmitter();
      const received = new EventEmitter();
      const posted = [];
      const panel = {
        viewType, title, where, reveal() {}, dispose() { this.disposed = true; dispose.fire(); },
        onDidDispose: dispose.event, onDidChangeViewState: new EventEmitter().event,
        webview: { html: '', cspSource: 'vscode-resource:', asWebviewUri: u => u, postMessage: async m => { posted.push(m); return true; }, onDidReceiveMessage: received.event },
        _received: received, _posted: posted,
      };
      calls.panels.push(panel);
      return panel;
    },
    registerTreeDataProvider: (id, provider) => { calls.treeProviders.push({ id, provider }); return new Disposable(); },
    registerWebviewViewProvider: (id, provider) => { calls.webviewProviders.push({ id, provider }); return new Disposable(); },
    registerFileDecorationProvider: provider => { calls.decorations.push(provider); return new Disposable(); },
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
      calls.executed.push([id, ...args]);
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
  extensionUri: Uri.file(root),
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
const deviceFetch = async (url, init = {}) => {
  let u = new URL(url);
  let authed = init.identity?.cert === clientCertPem && init.identity?.serverCert === serverPki.cert;
  // Requests through the extension's loopback proxy: the proxy presents the stored pairing.
  if (u.hostname === '127.0.0.1') {
    u = new URL(`https://${settings.host}:${settings.port}${u.pathname.replace(/^\/[^/]+/, '')}${u.search}`);
    authed = true;
  }
  if (init.identity && !authed && init.identity.serverCert !== serverPki.cert) throw new ext.TrustError();
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
    // A plugin from before pairing by key answers the handshake in plain HTTP.
    if (device.pairUnsupported) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'EPROTO', message: 'wrong version number' } });
    const n = device.pairRequests.length;
    const body = JSON.parse(init.body);
    const id = `req${n}`;
    const req = { id, code: device.tamperCode ? '0000' : deviceCode(body.public_key, id), body };
    device.pairRequests.push(req);
    return Object.assign(json({ id: req.id, code: req.code, poll_after_ms: 1000 }, 201), { peerCert: serverPeer });
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
    if (next === 'approved') device.rejectToken = false;
    if (next === 'approved') return json({ status: 'approved', client_cert: clientCertPem, server_cert: serverPki.cert, api_version: 2 });
    if (next === 'pending') await new Promise(r => setTimeout(r, 5));
    return json({ status: next });
  }
  if (!authed || device.rejectToken) return new Response('unauthorized', { status: 401 });
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
globalThis.fetch = deviceFetch;
const realDeviceFetch = ext.transportHooks.fetch;
ext.transportHooks.fetch = deviceFetch;

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
const welcomeFor = (view, context = calls.context) => pkg.contributes.viewsWelcome.filter(w => w.view === view && evalWhen(w.when, context)).map(w => w.contents);
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
const identityKey = 'decky-toolkit.identity:10.1.2.3:8765';
const storedIdentity = (k = identityKey) => (secrets.has(k) ? JSON.parse(secrets.get(k)) : undefined);
const storePaired = () => ctx.secrets.store(identityKey, JSON.stringify(pairedIdentity));
/** The identity a pairing stored: the device's certificates and the private key generated for it. */
function assertPaired(k = identityKey) {
  const id = storedIdentity(k);
  assert.ok(id, `no identity stored under ${k}`);
  assert.equal(id.cert, clientCertPem);
  assert.equal(id.serverCert.replace(/\s/g, ''), serverPki.cert.replace(/\s/g, ''), 'pins the certificate the device presented');
  assert.match(id.key, /^-----BEGIN PRIVATE KEY-----/);
  return id;
}
const lastMessage = kind => calls.messages.filter(m => m.kind === kind).at(-1);

ext.connectionTimings.healthPollMs = 40;
ext.connectionTimings.retryMs = 20;
ext.pairingTimings.retryMs = 20;
ext.controllerTimings.pollMs = 40;

// Fake LAN for discovery: interfaces, a /health per host and an mDNS responder behind a fake socket.
const net = {
  interfaces: { lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1', netmask: '255.0.0.0' }] },
  hosts: new Map(), probed: [], mdns: [], queries: [], slow: new Set(),
};
ext.discoveryHooks.interfaces = () => net.interfaces;
ext.discoveryHooks.fetch = async (url, init) => {
  const u = new URL(url);
  net.probed.push(u.host);
  if (net.slow.has(u.hostname)) {
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
  }
  const h = net.hosts.get(u.host);
  if (h === undefined) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'EHOSTUNREACH' } });
  return typeof h === 'string' ? new Response(h, { status: 200 }) : new Response(JSON.stringify(h), { status: 200, headers: { 'content-type': 'application/json' } });
};
ext.discoveryHooks.createSocket = () => {
  const on = {};
  return {
    bind: (_p, cb) => setTimeout(cb, 0),
    on: (ev, fn) => { on[ev] = fn; },
    setMulticastInterface: a => { net.iface = a; },
    setMulticastTTL: () => undefined,
    send: (msg, port, addr, cb) => {
      net.queries.push({ iface: net.iface, port, addr, msg: Buffer.from(msg) });
      setTimeout(() => { for (const [pkt, from] of net.mdns) on.message?.(pkt, { address: from }); cb(null); }, 1);
    },
    close: () => undefined,
  };
};
ext.discoveryTimings.mdnsMs = 150;
ext.discoveryTimings.probeTimeoutMs = 60;
ext.discoveryTimings.minRescanMs = 60_000;

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
    ['Open screen panel', 'decky-toolkit.openScreen'], ['Snapshot to file', 'decky-toolkit.snapshot']]],
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
    ['Write MCP config for this workspace', 'decky-toolkit.writeMcpConfig'], ['Copy MCP URL', 'decky-toolkit.copyMcpUrl']]],
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

await check('activate() replaces a screen tab orphaned by an extension host restart', async () => {
  assert.equal(calls.closedTabs.length, 1, 'the orphaned tab is closed');
  assert.deepEqual(orphanGroup.tabs, []);
  assert.equal(calls.panels.length, 1, 'a working screen panel takes its place');
  assert.deepEqual(calls.panels[0].where, { viewColumn: 2, preserveFocus: true }, 'same group; focus stays where it was');
  calls.panels[0].dispose();
  calls.panels.length = 0;
  for (const k of [...calls.context.keys()]) if (k.startsWith('decky-toolkit.screen.')) calls.context.delete(k);
  return 'orphan closed, new panel in column 2 without stealing focus';
});

await check('activate() registers the seven views and the decky: file system', async () => {
  const trees = [...calls.treeViews.map(t => t.id), ...calls.treeProviders.map(t => t.id)].sort();
  assert.deepEqual(trees, ['decky-toolkit.actions', 'decky-toolkit.controllers', 'decky-toolkit.devices', 'decky-toolkit.games', 'decky-toolkit.plugins']);
  assert.deepEqual(calls.fsProviders.map(f => [f.scheme, f.options]), [['decky', { isCaseSensitive: true }]]);
  assert.deepEqual(calls.webviewProviders.map(w => w.id), ['decky-toolkit.preview', 'decky-toolkit.welcome']);
  const declared = pkg.contributes.views['decky-toolkit'].map(v => [v.id, v.name]);
  assert.deepEqual(declared, [
    ['decky-toolkit.welcome', 'Devices'], ['decky-toolkit.devices', 'Devices'], ['decky-toolkit.actions', 'Actions'], ['decky-toolkit.plugins', 'Plugins'], ['decky-toolkit.games', 'Games'],
    ['decky-toolkit.controllers', 'Controllers'], ['decky-toolkit.preview', 'Preview']]);
  const games = pkg.contributes.views['decky-toolkit'].find(v => v.id === 'decky-toolkit.games');
  assert.equal(games.visibility, 'collapsed', 'Games starts collapsed like Plugins and Controllers');
  return `createTreeView(${trees.join(', ')}), registerWebviewViewProvider(decky-toolkit.preview, decky-toolkit.welcome)`;
});

await check('package.json: container, activation, commands, menus, version', async () => {
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/, 'Marketplace and Open VSX accept only major.minor.patch');
  assert.equal(pkg.contributes.configuration.properties['decky-toolkit.host'].default, '', 'no device is preconfigured for new users');
  const container = pkg.contributes.viewsContainers.activitybar[0];
  assert.equal(container.id, 'decky-toolkit');
  assert.equal(container.title, 'Decky');
  assert.equal(readFileSync(path.join(root, container.icon), 'utf8').includes('currentColor'), true);
  for (const v of pkg.contributes.views['decky-toolkit']) assert.ok(pkg.activationEvents.includes(`onView:${v.id}`), v.id);
  assert.equal(pkg.activationEvents.length, 11);
  assert.ok(pkg.activationEvents.includes('onFileSystem:decky'), 'restored decky:// folders activate the extension');
  for (const glob of ['plugin.json', '*/plugin.json', '*/*/plugin.json']) assert.ok(pkg.activationEvents.includes(`workspaceContains:${glob}`), glob);
  assert.deepEqual(pkg.contributes.keybindings, [{ command: 'decky-toolkit.deploy', key: 'ctrl+alt+d', mac: 'cmd+alt+d' }]);
  for (const v of pkg.contributes.views['decky-toolkit']) {
    const want = { 'decky-toolkit.welcome': '!decky-toolkit.hasDevices', 'decky-toolkit.devices': 'decky-toolkit.hasDevices' }[v.id] ?? 'decky-toolkit.link';
    assert.equal(v.when, want, `${v.id} when`);
  }
  const declared = new Set(pkg.contributes.commands.map(c => c.command));
  const registered = new Set(calls.commands.keys());
  for (const id of declared) assert.ok(registered.has(id), `declared but not registered: ${id}`);
  for (const id of registered) assert.ok(declared.has(id), `registered but not declared: ${id}`);
  const menus = Object.values(pkg.contributes.menus).flat();
  for (const m of menus) assert.ok(declared.has(m.command), `menu refers to unknown command ${m.command}`);
  for (const m of menus) evalWhen(m.when, new Map());
  const whens = [...menus.map(m => m.when), ...pkg.contributes.views['decky-toolkit'].map(v => v.when), ...pkg.contributes.viewsWelcome.map(w => w.when)];
  const allowedKeys = new Set(['view', 'viewItem', 'decky-toolkit.connected', 'decky-toolkit.link', 'false', 'activeWebviewPanelId',
    'decky-toolkit.hasDevices', 'config.decky-toolkit.discovery.enabled',
    'decky-toolkit.screen.live', 'decky-toolkit.screen.input', 'decky-toolkit.screen.audio', 'decky-toolkit.screen.muted', 'decky-toolkit.screen.paused']);
  for (const w of whens.filter(Boolean)) {
    for (const [, key] of w.replace(/\/(?:\\.|[^/])+\//g, '/re/').matchAll(/(?:^|&&|\|\||\(|!)\s*([A-Za-z][\w.-]*)/g)) assert.ok(allowedKeys.has(key), `context key ${key} in ${w}`);
  }
  const lostViews = ['decky-toolkit.actions', 'decky-toolkit.plugins', 'decky-toolkit.games', 'decky-toolkit.controllers'];
  assert.deepEqual([...new Set(pkg.contributes.viewsWelcome.map(w => w.view))], ['decky-toolkit.controllers', ...lostViews.filter(v => !v.endsWith('controllers'))]);
  for (const view of lostViews) {
    for (const link of ['connecting', 'unreachable', 'rejected', 'disconnected']) {
      const shown = welcomeFor(view, new Map([['decky-toolkit.link', link]]));
      assert.equal(shown.length, 1, `${view} ${link}: exactly one welcome`);
      if (link !== 'connecting') assert.match(shown[0], /\[(Reconnect|Reconnect now|Re-pair)\]\(command:decky-toolkit\.reconnect\)$/, `${view} ${link}`);
    }
    assert.deepEqual(welcomeFor(view, new Map([['decky-toolkit.link', 'connected']])).filter(t => /device/.test(t) && !/controllers/.test(t)), [], `${view} connected: no lost-connection text`);
  }
  assert.deepEqual(Object.keys(pkg.contributes.configuration.properties).sort(),
    ['decky-toolkit.deploy.build', 'decky-toolkit.deploy.onChange', 'decky-toolkit.discovery.enabled', 'decky-toolkit.host', 'decky-toolkit.mcpPort', 'decky-toolkit.openScreenOnConnect', 'decky-toolkit.pluginDirName', 'decky-toolkit.port']);
  assert.equal(pkg.contributes.configuration.properties['decky-toolkit.mcpPort'].default, 8766);
  assert.doesNotMatch(JSON.stringify(pkg.contributes), /\btoken\b|TLS|certificate|encrypted/i, 'user-facing strings name no mechanism');
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
    for (const viewItem of ['plugin', 'deck.unpaired', 'deck.paired', 'deck.session', 'deck.busy', 'deck.found', 'deck.found.saved', 'discovery.group', 'discovery.add', 'action', 'group.screen', 'controller.virtual', 'controller.physical', 'controller.unsupported',
      'game', 'game.running', 'game.unsupported', 'deckyDir', 'deckyFile', 'gameGroup', 'gameLog']) {
      for (const inline of [true, false]) assert.deepEqual(dupes(itemMenu(view, viewItem, inline)), [], `${view} ${viewItem}`);
    }
  }
  assert.deepEqual(visibleViews(new Map()), ['decky-toolkit.welcome'], 'before activation only the Add a device welcome shows');
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
  assert.deepEqual([...calls.context.keys()].sort(), ['decky-toolkit.connected', 'decky-toolkit.hasDevices', 'decky-toolkit.link'], 'the only context keys');
  assert.equal(calls.context.get('decky-toolkit.hasDevices'), true, 'one saved device');
  assert.equal(calls.context.get('decky-toolkit.link'), undefined, 'no link state before the first connect: only Devices shows');
  assert.deepEqual(visibleViews(), ['decky-toolkit.devices']);
  const rows = devicesProvider().getChildren();
  assert.equal(rows.length, 1);
  const [r] = rows;
  assert.equal(r.label, '10.1.2.3', 'name equal to host is shown once');
  assert.equal(r.description, 'v0.2.0 · not paired', 'the version comes from the public /health before pairing');
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
    devices: [], activeDevice: undefined, address: { host: 'h', port: 1 }, label: 'h', paired: !!client, rejected: false,
    connectedDevice: client ? { id: 'x', name: 'h', host: 'h', port: 1 } : undefined, link: client ? 'connected' : undefined, linkLabel: 'h',
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
  const down = new ext.ActionsTreeProvider(fakeConn({}, { health: { kind: 'unreachable', error: 'cannot reach the device' }, link: 'unreachable' }));
  assert.deepEqual(await down.getChildren(), [], 'unreachable: empty, so the lost-connection welcome shows');
  down.dispose();
  const downPlugins = new ext.PluginsTreeProvider(fakeConn({ listPlugins: async () => plugins }, { link: 'unreachable' }));
  assert.deepEqual(await downPlugins.getChildren(), []);
  return 'list / empty / error placeholder / not connected / unreachable → empty';
});

await check('preview webview: CSP and proxy URL, no secrets', async () => {
  const { provider } = calls.webviewProviders.find(w => w.id === 'decky-toolkit.preview');
  const messages = new EventEmitter();
  const posted = [];
  const webview = { options: {}, html: '', cspSource: 'vscode-resource:', asWebviewUri: u => u, postMessage: async m => { posted.push(m); return true; }, onDidReceiveMessage: messages.event, _posted: posted };
  const view = { webview, visible: true, onDidChangeVisibility: new EventEmitter().event, onDidDispose: () => new Disposable() };
  await provider.resolveWebviewView(view);
  calls.previewView = view;
  assert.match(webview.html, /default-src 'none'/);
  assert.match(webview.html, /img-src http:\/\/127\.0\.0\.1:\d+ blob:/);
  assert.match(webview.html, /<button id="open" hidden>Open full screen view/, 'not connected yet: the button is hidden');
  assert.match(webview.html, /data-live="false"/);
  assert.ok(!webview.html.includes('PRIVATE KEY') && !webview.html.includes('CERTIFICATE'));
  assert.equal(webview.options.enableScripts, true);
  return 'ok';
});

await check('welcome view: flat logo, Add a device, plugin requirement, pairing walkthrough; shown only without devices', async () => {
  const { provider } = calls.webviewProviders.find(w => w.id === 'decky-toolkit.welcome');
  const messages = new EventEmitter();
  const webview = { options: {}, html: '', cspSource: 'vscode-resource:', asWebviewUri: u => u, postMessage: async () => true, onDidReceiveMessage: messages.event };
  provider.resolveWebviewView({ webview, visible: true, onDidChangeVisibility: new EventEmitter().event, onDidDispose: () => new Disposable() });
  const html = webview.html;
  assert.match(html, /default-src 'none'; style-src 'nonce-[^']+'; script-src 'nonce-[^']+'/);
  assert.doesNotMatch(html, /https?:\/\/(?!github\.com\/jackhric\/decky-toolkit|www\.w3\.org\/2000\/svg)/, 'nothing loads from the network');
  assert.match(html, /<svg class="mark"[^>]*viewBox="140 140 480 470"/, 'the flat mark is inlined so it takes the theme colour');
  assert.match(html, /<button id="add"[^>]*><svg[^>]*>.*<\/svg>Add a device<\/button>/s);
  assert.match(html, /needs Decky Loader and the <a id="plugin" href="https:\/\/github\.com\/jackhric\/decky-toolkit"/);
  assert.match(html, /How pairing works/);
  const css = html.match(/<style[^>]*>([\s\S]*?)<\/style>/)[1];
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgb|hsl/i, 'colours come from --vscode-* tokens only');

  ui.inputBox = () => undefined;
  messages.fire({ type: 'add' });
  messages.fire({ type: 'plugin' });
  messages.fire({ type: 'pairing' });
  await settle();
  assert.ok(calls.executed.some(([id]) => id === 'decky-toolkit.addDevice'));
  assert.equal(lastMessage('warning').m, 'Replace 10.1.2.3?', 'a device is saved, so Add a device asks to replace it');
  assert.equal(globalState.get('decky-toolkit.devices').length, 1, 'cancelled: nothing changed');
  calls.messages.length = 0;
  assert.equal(calls.opened.at(-1), 'https://github.com/jackhric/decky-toolkit');
  assert.deepEqual(calls.executed.find(([id]) => id === 'workbench.action.openWalkthrough'), ['workbench.action.openWalkthrough', 'jackhric.decky-toolkit#pairing', false]);

  const walk = pkg.contributes.walkthroughs.find(w => w.id === 'pairing');
  assert.deepEqual(walk.steps.map(st => st.id), ['install', 'add', 'approve', 'screen']);
  for (const st of walk.steps) assert.ok(existsSync(path.join(root, st.media.svg)), st.media.svg);
  assert.match(walk.steps[0].description, /jackhric\.github\.io\/decky-toolkit\/decky-toolkit\.zip/);
  assert.equal(calls.context.get('decky-toolkit.hasDevices'), true, 'a saved device shows the tree instead');
  assert.deepEqual(visibleViews(new Map([['decky-toolkit.hasDevices', false]])), ['decky-toolkit.welcome']);
  return 'add → decky-toolkit.addDevice, plugin → GitHub, pairing → walkthrough (4 steps); welcome ⇄ tree on decky-toolkit.hasDevices';
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
  assert.ok(!fetched.slice(0, fetched.indexOf('/pair/request')).includes('/stream/stats'), 'not paired, so no pairing check before pairing');
  const { public_key: publicKey, ...rest } = device.pairRequests[0].body;
  assert.deepEqual(rest, { client_name: `VS Code on ${hostname()}`, client_kind: 'vscode' });
  assert.match(publicKey, /^-----BEGIN PUBLIC KEY-----/, 'sends only the public key');
  assert.equal(createPublicKey(publicKey).asymmetricKeyDetails.namedCurve, 'prime256v1');
  const code = device.pairRequests[0].code;
  assert.equal(code, ext.pairingCode(serverPeer.der, createPublicKey(publicKey).export({ type: 'spki', format: 'der' }), 'req0'));
  const prog = calls.progress.at(-1);
  assert.equal(prog.title, 'Decky Toolkit');
  assert.equal(prog.messages[0], `Waiting for approval on 10.1.2.3 · code ${code}. On the device: Quick Access → Decky Toolkit → Approve.`);
  assert.ok(!prog.messages.some(m => /\d+ s\b|120/.test(m)), 'no countdown');
  assert.equal(rowDuringPairing.description, `v0.2.0 · waiting for approval · code ${code}`);
  assert.equal(rowDuringPairing.contextValue, 'deck.busy');
  const stored = assertPaired();
  assert.equal(createPublicKey(stored.key).export({ type: 'spki', format: 'pem' }), publicKey, 'stores the key it sent');
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
  assert.equal(r.description, 'v0.2.0 · connected');
  assert.equal(r.iconPath.id, 'vm-connect');
  assert.equal(r.iconPath.color.id, 'testing.iconPassed');
  assert.equal(r.contextValue, 'deck.session');
  assert.equal(r.command, undefined);
  assert.deepEqual(itemMenu('decky-toolkit.devices', r.contextValue, true), ['decky-toolkit.disconnectDevice', 'decky-toolkit.deviceActions']);
  const ctxMenu = itemMenu('decky-toolkit.devices', r.contextValue, false);
  for (const bad of ['decky-toolkit.connect', 'decky-toolkit.pair']) assert.ok(!ctxMenu.includes(bad), `${bad} on a connected device`);
  assert.deepEqual(ctxMenu.filter(m => !/connect/i.test(m)), ['decky-toolkit.renameDevice', 'decky-toolkit.removeDevice'], 'right-click: Disconnect, Rename and Forget only');
  assert.equal(pkg.contributes.commands.find(c => c.command === 'decky-toolkit.removeDevice').title, 'Forget device');
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
  assert.match(kids.Screen[1].tooltip, /frame\.jpg/);
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

await check('Screen and MCP leaves: snapshot, MCP URL', async () => {
  ui.saveDialog = opts => opts.defaultUri;
  await run('decky-toolkit.snapshot');
  const dlg = calls.saveDialogs.at(-1);
  assert.match(dlg.defaultUri.toString(), /\/screen-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.jpg$/);
  const w = calls.written.at(-1);
  assert.equal(w.uri, dlg.defaultUri.toString());
  assert.deepEqual([...w.data], [...frameJpeg]);
  assert.match(lastMessage('info').m, /saved .*screen-.*\.jpg/);
  await run('decky-toolkit.copyMcpUrl');
  const secret = globalState.get('decky-toolkit.proxySecret');
  assert.match(calls.clipboard.at(-1), new RegExp(`^http://127\\.0\\.0\\.1:\\d+/${secret}/mcp$`), 'the loopback proxy, not the device');
  assert.ok(Number(new URL(calls.clipboard.at(-1)).port) >= 8766, 'decky-toolkit.mcpPort or the next free port');
  const mcpUrl = calls.clipboard.at(-1);

  // Write MCP config: the proxy URL with no headers; other servers and stale fields of ours are replaced.
  const mcpJson = 'file:///ws/.mcp.json';
  vscode.workspace.workspaceFolders = [{ uri: Uri.file('/ws'), name: 'ws', index: 0 }];
  try {
    files.set(mcpJson, Buffer.from(JSON.stringify({ mcpServers: { other: { command: 'x' }, decky: { type: 'http', url: 'http://10.1.2.3:8765/mcp', headers: { Authorization: 'Bearer old' } } } })));
    await run('decky-toolkit.writeMcpConfig');
    const written = JSON.parse(Buffer.from(calls.written.at(-1).data).toString());
    assert.equal(calls.written.at(-1).uri, mcpJson);
    assert.deepEqual(written.mcpServers, { other: { command: 'x' }, decky: { type: 'http', url: mcpUrl } });
    assert.equal(lastMessage('info').m, 'Decky Toolkit: wrote mcpServers.decky to .mcp.json.');

    // Activation: an entry on another port with our prefix is moved to this window's port; anything else is left alone.
    const moved = mcpUrl.replace(/:\d+\//, ':40999/');
    files.set(mcpJson, Buffer.from(JSON.stringify({ mcpServers: { decky: { type: 'http', url: moved, note: 'kept' } } })));
    const before = calls.written.length;
    await ext.refreshMcpConfig({ proxy: { rebase: async u => (u === moved ? mcpUrl : undefined) } });
    assert.deepEqual(JSON.parse(Buffer.from(calls.written.at(-1).data).toString()).mcpServers.decky, { type: 'http', url: mcpUrl, note: 'kept' });
    files.set(mcpJson, Buffer.from(JSON.stringify({ mcpServers: { decky: { type: 'http', url: 'http://127.0.0.1:40999/someone-else/mcp' } } })));
    await ext.refreshMcpConfig({ proxy: { rebase: async () => undefined } });
    files.set(mcpJson, Buffer.from('not json'));
    await ext.refreshMcpConfig({ proxy: { rebase: async () => mcpUrl } });
    assert.equal(calls.written.length, before + 1, 'unrelated or broken files are not touched');
  } finally {
    files.delete(mcpJson);
    vscode.workspace.workspaceFolders = undefined;
  }
  return `snapshot → ${dlg.defaultUri.path.split('/').pop()} (${w.data.length} B); MCP URL ${mcpUrl.replace(secret, '<secret>')}; .mcp.json written and re-pointed`;
});

// The real media/screen.js in a minimal DOM: what the webview does with the extension's messages.
function loadScreenJs({ live } = {}) {
  const src = readFileSync(path.join(root, 'media', 'screen.js'), 'utf8');
  const els = new Map();
  const el = id => {
    if (!els.has(id)) {
      const classes = new Set();
      els.set(id, {
        id, textContent: '', hidden: id === 'hint', addEventListener() {}, focus() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1920, height: 1080 }),
        classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c), toggle: (c, on) => ((on ?? !classes.has(c)) ? classes.add(c) : classes.delete(c), classes.has(c)) },
      });
    }
    return els.get(id);
  };
  const listeners = {}, posted = [], sent = [], sockets = [];
  const fakeVscode = { postMessage: m => posted.push(m) };
  const fetches = [];
  const dataset = { base: 'http://127.0.0.1:1/x', ...(live === undefined ? {} : { live: String(live) }) };
  const document = { getElementById: el, body: { dataset }, addEventListener() {}, hasFocus: () => true };
  const window = { addEventListener: (t, fn) => { (listeners[t] ??= []).push(fn); } };
  class FakeWs { constructor(url) { this.url = url; this.readyState = 1; sockets.push(this); } send(d) { sent.push(JSON.parse(d)); } close() { this.closed = true; } }
  FakeWs.OPEN = 1;
  const pads = { list: [] };
  const navigator = { getGamepads: () => pads.list };
  new Function('acquireVsCodeApi', 'document', 'window', 'fetch', 'WebSocket', 'requestAnimationFrame', 'navigator', src)(
    () => fakeVscode, document, window, url => { fetches.push(url); return new Promise(() => {}); }, FakeWs, () => 0, navigator);
  const post = data => listeners.message.forEach(fn => fn({ data }));
  const fire = t => (listeners[t] ?? []).forEach(fn => fn({}));
  return { el, post, fire, posted, sent, sockets, pads, fetches };
}
const titleActions = (panelId = 'decky-toolkit.screen') => pkg.contributes.menus['editor/title']
  .filter(m => evalWhen(m.when, new Map([...calls.context, ['activeWebviewPanelId', panelId]]))).map(m => m.command);
const icon = id => pkg.contributes.commands.find(c => c.command === id).icon;
// Answers QuickPicks in order by label (prefix match); records what was offered.
function answerPicks(...labels) {
  const offered = [];
  ui.quickPick = (items, opts) => {
    offered.push({ labels: items.map(i => i.label), descriptions: items.map(i => i.description), opts });
    const want = labels.shift();
    return want === undefined ? undefined : items.find(i => i.label === want || i.label.endsWith(' ' + want));
  };
  return offered;
}

await check('remote input: title action, toggle command, status bar, unavailable / unsupported', async () => {
  const panel = calls.panels[0];
  const lastState = () => panel._posted.filter(m => m.type === 'input').at(-1)?.state;
  assert.match(panel.webview.html, /connect-src http:\/\/127\.0\.0\.1:(\d+) ws:\/\/127\.0\.0\.1:\1;/);
  assert.doesNotMatch(panel.webview.html, /<header|<button|<select|<input/, 'no controls inside the page');
  assert.equal(pkg.contributes.commands.find(c => c.command === 'decky-toolkit.toggleInput').title, 'Toggle remote input');
  assert.ok(!(await actionsTree()).kids.Screen.some(c => /input/i.test(c.label)), 'no input leaf in the Actions view');

  panel._posted.length = 0;
  panel._received.fire({ type: 'ready' });
  await settle();
  assert.deepEqual(lastState(), { enabled: false });
  assert.equal(calls.context.get('decky-toolkit.screen.input'), 'off');
  assert.ok(titleActions().includes('decky-toolkit.screen.inputOn'));
  assert.equal(icon('decky-toolkit.screen.inputOn'), '$(keyboard)');
  assert.equal(status(), '$(vm-connect) 10.1.2.3');

  fetched.length = 0;
  await run('decky-toolkit.screen.inputOn');
  await settle();
  assert.deepEqual(fetched.filter(f => f === '/input/settings').length, 2, 'GET then PUT');
  assert.equal(device.input.enabled, true);
  assert.deepEqual(lastState(), { enabled: true });
  assert.equal(calls.context.get('decky-toolkit.screen.input'), 'on');
  assert.ok(titleActions().includes('decky-toolkit.screen.inputOff') && !titleActions().includes('decky-toolkit.screen.inputOn'));
  assert.equal(icon('decky-toolkit.screen.inputOff'), '$(record-keys)');
  assert.equal(status(), '$(vm-connect) 10.1.2.3 $(keyboard)');
  assert.match(calls.statusItems[0].tooltip, /remote input on/);
  assert.match(calls.statusMessages.at(-1), /remote input on \(libei\)/);

  await run('decky-toolkit.toggleInput');
  await settle();
  assert.equal(device.input.enabled, false);
  assert.deepEqual(lastState(), { enabled: false }, 'the panel follows a toggle from the palette');
  assert.equal(calls.context.get('decky-toolkit.screen.input'), 'off');

  device.input = { enabled: false, backend: null, available: false, reason: 'no libei socket and /dev/uinput is not writable' };
  await run('decky-toolkit.screen.inputOn');
  await settle();
  assert.match(lastMessage('warning').m, /remote input is unavailable on 10\.1\.2\.3: no libei socket/);
  assert.equal(device.input.enabled, false, 'nothing PUT while unavailable');

  device.inputSupported = false;
  await run('decky-toolkit.toggleInput');
  assert.match(lastMessage('warning').m, /not supported by this device version/);
  await settle();
  assert.equal(lastState(), null);

  device.inputSupported = true;
  device.input = { enabled: false, backend: 'ei', available: true, reason: null };
  await run('decky-toolkit.refresh');
  await settle(100);
  assert.deepEqual(lastState(), { enabled: false });
  assert.deepEqual(titleActions('markdown.preview'), [], 'actions only on the screen panel');

  // screen.js opens /input only while input is on; a 4003 close asks the extension for the state again.
  const w = loadScreenJs();
  w.post({ type: 'input', state: { enabled: true } });
  const sock = w.sockets.find(s => s.url.endsWith('/input'));
  assert.ok(sock, '/input socket opened');
  sock.onclose({ code: 4003, reason: 'remote input is disabled' });
  assert.deepEqual(w.posted.at(-1), { type: 'refreshInput' });
  assert.equal(w.el('hint').textContent, 'remote input is disabled');
  return 'title keyboard → record-keys while on, $(keyboard) in status bar, palette toggle off, unavailable warning, 404 → no state';
});

await check('screen panel: title actions and icons, stream settings QuickPick, mute / volume / pause', async () => {
  const panel = calls.panels[0];
  const audioMsgs = () => panel._posted.filter(m => m.type === 'audio');
  panel._posted.length = 0; fetched.length = 0;
  panel._received.fire({ type: 'ready' });
  await settle();
  assert.ok(fetched.includes('/stream/settings'));
  assert.deepEqual(audioMsgs().at(-1), { type: 'audio', on: true, muted: false, volume: 0.8 });
  assert.deepEqual(titleActions(), ['decky-toolkit.screen.inputOn', 'decky-toolkit.screen.mute', 'decky-toolkit.screen.settings', 'decky-toolkit.screen.pause', 'decky-toolkit.snapshot']);
  assert.deepEqual(titleActions().map(icon), ['$(keyboard)', '$(unmute)', '$(settings-gear)', '$(debug-pause)', '$(device-camera)']);
  assert.ok(pkg.contributes.menus['editor/title'].every(m => m.group.startsWith('navigation@')), 'all inline in the tab bar');

  await run('decky-toolkit.screen.mute');
  assert.deepEqual(audioMsgs().at(-1), { type: 'audio', on: true, muted: true, volume: 0.8 });
  assert.equal(globalState.get('decky-toolkit.screen.muted'), true, 'mute is remembered');
  await run('decky-toolkit.screen.pause');
  assert.deepEqual(panel._posted.filter(m => m.type === 'paused').at(-1), { type: 'paused', paused: true });
  assert.deepEqual(titleActions().map(icon), ['$(keyboard)', '$(mute)', '$(settings-gear)', '$(play)', '$(device-camera)']);
  await run('decky-toolkit.screen.resume');

  let offered = answerPicks('Frame rate', '60 fps');
  await run('decky-toolkit.screen.settings');
  await settle();
  assert.deepEqual(offered[0].labels.map(l => l.replace(/^\$\([^)]+\) /, '')),
    ['Stream · every client', 'Frame rate', 'JPEG quality', 'Size', 'Audio', 'This computer', 'Volume', 'Gamepad goes to']);
  assert.deepEqual(offered[0].descriptions.filter(Boolean), ['30 fps', '70', 'Native', 'On', '80% (muted)', 'Auto']);
  assert.equal(offered[1].descriptions[offered[1].labels.indexOf('30 fps')], 'current');
  assert.deepEqual(device.streamPuts.at(-1), { fps: 60 });
  assert.equal(panel._posted.at(-1).type, 'applying', 'the webview shows "Applying" until the new pipeline sends a frame');

  answerPicks('Volume', '40%');
  await run('decky-toolkit.screen.settings');
  await settle();
  assert.deepEqual(audioMsgs().at(-1), { type: 'audio', on: true, muted: false, volume: 0.4 }, 'a volume pick unmutes');
  assert.equal(globalState.get('decky-toolkit.screen.volume'), 0.4);

  answerPicks('Audio');
  await run('decky-toolkit.screen.settings');
  await settle();
  assert.deepEqual(device.streamPuts.at(-1), { audio: false });
  assert.equal(audioMsgs().at(-1).on, false);
  assert.ok(!titleActions().includes('decky-toolkit.screen.mute'), 'no mute action while the device sends no audio');
  offered = answerPicks();
  await run('decky-toolkit.screen.settings');
  assert.ok(!offered[0].labels.some(l => /Volume/.test(l)));

  // A change made elsewhere arrives with the stats tick.
  stats.settings = { ...stats.settings, audio: true };
  await run('decky-toolkit.refresh');
  await settle(100);
  assert.equal(audioMsgs().at(-1).on, true);
  assert.equal(calls.context.get('decky-toolkit.screen.audio'), true);

  // A device without stream settings: only this computer's choices.
  device.streamSettingsMissing = true;
  panel._received.fire({ type: 'ready' });
  await settle();
  offered = answerPicks();
  await run('decky-toolkit.screen.settings');
  assert.deepEqual(offered[0].labels.map(l => l.replace(/^\$\([^)]+\) /, '')), ['This computer', 'Gamepad goes to']);
  device.streamSettingsMissing = false;
  stats.settings = { fps: 30, quality: 70, width: 0, audio: true };
  panel._received.fire({ type: 'ready' });
  await settle();

  const w = loadScreenJs();
  assert.deepEqual(w.posted.at(-1), { type: 'ready' });
  w.post({ type: 'audio', on: true, muted: true, volume: 0.5 });
  assert.ok(w.sockets.some(s => s.url.endsWith('/audio')), 'audio socket opened');
  assert.equal(w.el('hint').hidden, false);
  assert.equal(w.el('hint').textContent, 'Click the picture to enable audio', 'no running AudioContext yet');
  w.post({ type: 'audio', on: false, muted: true, volume: 0.5 });
  assert.equal(w.el('hint').hidden, true, 'device audio off: no hint');
  w.post({ type: 'paused', paused: true });
  w.post({ type: 'applying' });
  return 'title: keyboard, unmute, settings-gear, debug-pause, device-camera; mute → $(mute), pause → $(play); fps 60 PUT; volume 40% unmutes; audio off hides mute';
});

await check('Controllers view with fake clients: empty, physical + virtual, 404, error', async () => {
  const fakeConn = client => ({ connectedDevice: { id: 'x', name: 'h', host: 'h', port: 1 }, link: 'connected', authedClient: () => client, onDidChange: new EventEmitter().event, onDidChangeTarget: new EventEmitter().event, label: 'h' });
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

await check('screen panel: "Gamepad goes to" QuickPick, new pad, removed pad → Auto, pad field on gamepad messages', async () => {
  const panel = calls.panels[0];
  const targets = () => panel._posted.filter(m => m.type === 'padTarget').map(m => m.id);
  panel._posted.length = 0;
  panel._received.fire({ type: 'ready' });
  await settle();
  assert.deepEqual(targets(), ['']);
  ui.inputBox = () => 'Couch';
  answerPicks('Gamepad goes to', 'New virtual pad…');
  await run('decky-toolkit.screen.settings');
  await settle(100);
  const id = ctl.virtual.find(v => v.name === 'Couch').id;
  assert.equal(targets().at(-1), id, 'the new pad becomes the target');
  const offered = answerPicks('Gamepad goes to');
  await run('decky-toolkit.screen.settings');
  assert.equal(offered[0].descriptions.at(-1), 'Couch');
  assert.deepEqual(offered[1].labels, ['Auto', 'Couch', '$(add) New virtual pad…'], 'the auto pad is "Auto", not a choice');
  assert.equal(offered[1].descriptions[1], 'current');
  await run('decky-toolkit.removeVirtualController', id);
  await run('decky-toolkit.refreshControllers');
  await settle(100);
  assert.equal(targets().at(-1), '', 'a removed target falls back to Auto');
  ctl.missing = true;
  await run('decky-toolkit.refreshControllers');
  await settle();
  const older = answerPicks();
  await run('decky-toolkit.screen.settings');
  assert.ok(!older[0].labels.some(l => /Gamepad/.test(l)), 'older device: no choice');
  ctl.missing = false;
  await run('decky-toolkit.refreshControllers');
  await settle();

  const w = loadScreenJs();
  w.post({ type: 'input', state: { enabled: true } });
  w.sockets[0].onopen?.();
  const pressed = i => ({ pressed: i === 0, value: i === 0 ? 1 : 0 });
  w.pads.list = [{ connected: true, mapping: 'standard', buttons: Array.from({ length: 17 }, (_, i) => pressed(i)), axes: [0, 0, 0, 0] }];
  w.fire('gamepadconnected');
  assert.equal(w.el('hint').textContent, 'Gamepad connected');
  const gp = () => w.sent.filter(m => m.type === 'gamepad');
  assert.equal(gp().at(-1).buttons.a, true);
  assert.equal('pad' in gp().at(-1), false, 'Auto sends no pad field');
  w.post({ type: 'padTarget', id: 'v2' });
  assert.deepEqual([gp().at(-1).buttons.a, 'pad' in gp().at(-1)], [false, false], 'Auto got a neutral state first');
  w.fire('gamepadconnected');
  assert.deepEqual([gp().at(-1).buttons.a, gp().at(-1).pad], [true, 'v2']);
  w.pads.list = [];
  w.fire('gamepaddisconnected');
  return 'New virtual pad… → target, list Auto / Couch / New virtual pad…, removed → Auto, 404 → no choice; Auto → no pad field, v2 → pad "v2"';
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

const LOST_VIEWS = ['actions', 'plugins', 'games', 'controllers'];
const lostNotes = () => (calls.channels.get('Decky Loader') ?? []).filter(l => l.startsWith('[decky-toolkit]'));

await check('connection lost: views stay but go blank, screen panel / preview / logs / decky:// files say so, then recover by themselves', async () => {
  await run('decky-toolkit.openScreen');
  const panel = calls.panels.at(-1);
  panel._received.fire({ type: 'ready' });
  await run('decky-toolkit.loaderLogs');
  await settle();
  const linkMsg = () => panel._posted.filter(m => m.type === 'link').at(-1);
  const previewState = () => calls.previewView.webview._posted.filter(m => m.type === 'state').at(-1);
  assert.deepEqual(linkMsg(), { type: 'link', live: true, text: '' });
  assert.deepEqual(previewState(), { type: 'state', live: true, text: '' });
  assert.equal(panel.title, 'Screen: 10.1.2.3');
  assert.equal(calls.context.get('decky-toolkit.screen.live'), true);
  assert.ok(!titleActions().includes('decky-toolkit.reconnect'));
  const deco = calls.decorations[0];
  const file = ext.deckyUri({ host: '10.1.2.3', port: 8765 }, '/home/jackh/.local/share/VVVVVV/saves/tsave.vvv');
  assert.equal(deco.provideFileDecoration(file), undefined);
  const views = visibleViews();
  assert.deepEqual(views, pkg.contributes.views['decky-toolkit'].map(v => v.id).filter(id => id !== 'decky-toolkit.welcome'));
  const notesBefore = lostNotes().length;

  device.up = false;
  await settle(150);
  let [r] = devicesProvider().getChildren();
  assert.equal(r.description, 'v0.2.0 · unreachable');
  assert.equal(r.iconPath.id, 'warning');
  assert.equal(calls.context.get('decky-toolkit.connected'), true, 'the session and its token stay');
  assert.equal(calls.context.get('decky-toolkit.link'), 'unreachable');
  assert.deepEqual(visibleViews(), views, 'no view disappears');
  for (const id of LOST_VIEWS) {
    assert.deepEqual(await tree(`decky-toolkit.${id}`).provider.getChildren(), [], `${id} is blank`);
    assert.equal(tree(`decky-toolkit.${id}`).view.description, '10.1.2.3 · connection lost');
    const [welcome, ...more] = welcomeFor(`decky-toolkit.${id}`);
    assert.equal(more.length, 0, `${id}: one welcome`);
    assert.match(welcome, /^Lost connection to the device\..*\n\[Reconnect now\]\(command:decky-toolkit\.reconnect\)$/s);
  }
  assert.equal(calls.previewView.description, '10.1.2.3 · connection lost');
  assert.deepEqual(previewState(), { type: 'state', live: false, text: 'Lost connection to 10.1.2.3.\nReconnecting as soon as it answers again…' });
  assert.equal(status(), '$(debug-disconnect) 10.1.2.3: connection lost');
  assert.equal(calls.statusItems[0].backgroundColor.id, 'statusBarItem.warningBackground');
  assert.equal(calls.statusItems[0].command, 'decky-toolkit.reconnect');
  assert.equal(panel.title, 'Screen: 10.1.2.3 (connection lost)', 'the panel stays open and its tab says why');
  assert.deepEqual(linkMsg(), { type: 'link', live: false, text: 'Lost connection to 10.1.2.3.\nReconnecting as soon as it answers again…' });
  assert.equal(calls.context.get('decky-toolkit.screen.live'), false);
  assert.deepEqual(titleActions(), ['decky-toolkit.reconnect', 'decky-toolkit.screen.mute', 'decky-toolkit.screen.pause'], 'device actions give way to Reconnect');
  assert.equal(icon('decky-toolkit.reconnect'), '$(plug)');
  const notes = lostNotes().slice(notesBefore);
  assert.deepEqual(notes, ['[decky-toolkit] Lost connection to 10.1.2.3. Output resumes when it is connected again.'], 'the log channel says it once');
  const d = deco.provideFileDecoration(file);
  assert.equal(d.badge, '!');
  assert.equal(d.color.id, 'list.warningForeground');
  assert.match(d.tooltip, /Lost connection to 10\.1\.2\.3; files open and save again/);
  assertPaired();

  fetched.length = 0;
  device.up = true;
  await settle(150);
  [r] = devicesProvider().getChildren();
  assert.equal(r.description, 'v0.2.0 · connected');
  assert.equal(calls.context.get('decky-toolkit.link'), 'connected');
  assert.equal(status(), '$(vm-connect) 10.1.2.3');
  assert.equal(calls.statusItems[0].backgroundColor, undefined);
  assert.equal((await actionsProvider().getChildren()).length, 5, 'Actions fill again');
  assert.ok(labels(await pluginsProvider().getChildren()).includes('Tender'), 'Plugins fill again');
  assert.equal(tree('decky-toolkit.actions').view.description, '10.1.2.3');
  assert.equal(panel.title, 'Screen: 10.1.2.3');
  assert.deepEqual(linkMsg(), { type: 'link', live: true, text: '' });
  assert.equal(calls.context.get('decky-toolkit.screen.live'), true);
  assert.ok(fetched.includes('/stream/settings'), 'stream settings reloaded after the outage');
  assert.deepEqual(previewState(), { type: 'state', live: true, text: '' });
  assert.ok(lostNotes().slice(notesBefore).includes('[decky-toolkit] Connected to 10.1.2.3 again.'));
  assert.equal(deco.provideFileDecoration(file), undefined);
  assert.equal(panel.disposed, undefined, 'the screen panel was never closed');
  return 'views kept + blank with "Lost connection" welcome; title "(connection lost)"; status warning; one log line; decky:// "!" badge; all back on recovery';
});

await check('screen.js: a lost link stops the stream, input and audio and dims the last frame; recovery restarts them', async () => {
  const w = loadScreenJs();
  assert.equal(w.fetches.length, 1, 'stream started');
  w.post({ type: 'input', state: { enabled: true } });
  w.post({ type: 'audio', on: true, muted: false, volume: 0.8 });
  const [input, audio] = ['/input', '/audio'].map(p => w.sockets.find(s => s.url.endsWith(p)));
  assert.ok(input && audio);
  w.post({ type: 'link', live: false, text: 'Lost connection to Deck.\nReconnecting as soon as it answers again…' });
  assert.equal(w.el('msg').textContent, 'Lost connection to Deck.\nReconnecting as soon as it answers again…');
  assert.equal(w.el('msg').hidden, false);
  assert.ok(w.el('main').classList.contains('offline'), 'last frame dimmed');
  assert.ok(input.closed && audio.closed, 'sockets closed');
  w.post({ type: 'visible', visible: false });
  w.post({ type: 'visible', visible: true });
  w.post({ type: 'reconnect' });
  w.post({ type: 'input', state: { enabled: true } });
  assert.equal(w.fetches.length, 1, 'nothing fetched while offline');
  assert.equal(w.sockets.length, 2, 'no socket opened while offline');
  w.post({ type: 'link', live: true, text: '' });
  assert.equal(w.fetches.length, 2, 'stream restarted');
  assert.equal(w.el('msg').textContent, 'Connecting…');
  assert.ok(!w.el('main').classList.contains('offline'));
  assert.deepEqual(w.sockets.slice(2).map(s => s.url.split('/').pop()).sort(), ['audio', 'input']);
  const cold = loadScreenJs({ live: false });
  assert.equal(cold.fetches.length, 0, 'a panel opened while offline does not fetch');
  return 'offline: msg + dimmed + sockets closed + no fetch; live again: stream, input and audio back';
});

await check('user Disconnect: views stay blank with "Disconnected" and Reconnect, screen panel stays open; Reconnect restores it', async () => {
  const panel = calls.panels.at(-1);
  const notesBefore = lostNotes().length;
  await run('decky-toolkit.disconnectDevice');
  await settle();
  assert.equal(calls.context.get('decky-toolkit.connected'), false);
  assert.equal(calls.context.get('decky-toolkit.link'), 'disconnected');
  assert.deepEqual(visibleViews(), pkg.contributes.views['decky-toolkit'].map(v => v.id).filter(id => id !== 'decky-toolkit.welcome'), 'the layout does not jump');
  for (const id of LOST_VIEWS) {
    assert.deepEqual(await tree(`decky-toolkit.${id}`).provider.getChildren(), [], `${id} is blank`);
    assert.deepEqual(welcomeFor(`decky-toolkit.${id}`), ['Disconnected from the device.\n[Reconnect](command:decky-toolkit.reconnect)']);
    assert.equal(tree(`decky-toolkit.${id}`).view.description, '10.1.2.3 · disconnected');
  }
  const [r] = devicesProvider().getChildren();
  assert.equal(r.description, 'v0.2.0 · paired');
  assert.equal(r.iconPath.id, 'vm');
  assert.equal(r.contextValue, 'deck.paired');
  assert.equal(r.command.command, 'decky-toolkit.connect');
  assert.deepEqual(itemMenu('decky-toolkit.devices', r.contextValue, true), ['decky-toolkit.connect', 'decky-toolkit.deviceActions']);
  assertPaired();
  assert.equal(status(), '$(vm) Decky: not connected');
  assert.equal(panel.disposed, undefined, 'not closed');
  assert.equal(panel.title, 'Screen: 10.1.2.3 (disconnected)');
  assert.match(panel._posted.filter(m => m.type === 'link').at(-1).text, /^Disconnected from 10\.1\.2\.3\./);
  assert.deepEqual(lostNotes().slice(notesBefore), ['[decky-toolkit] Disconnected from 10.1.2.3. Output resumes when it is connected again.']);
  const file = ext.deckyUri({ host: '10.1.2.3', port: 8765 }, '/home/jackh/.local/share/VVVVVV/saves/tsave.vvv');
  assert.equal(calls.decorations[0].provideFileDecoration(file), undefined, 'decky:// still works with the stored token');

  fetched.length = 0;
  await run('decky-toolkit.reconnect');
  await settle();
  assert.equal(calls.context.get('decky-toolkit.link'), 'connected');
  assert.ok(fetched.includes('/health') && !fetched.includes('/pair/request'));
  assert.equal(panel.title, 'Screen: 10.1.2.3');
  assert.ok(lostNotes().slice(notesBefore).includes('[decky-toolkit] Connected to 10.1.2.3 again.'));
  assert.equal((await actionsProvider().getChildren()).length, 5);
  panel.dispose();
  await run('decky-toolkit.disconnectDevice');
  await settle();
  return `row "${r.label}" — "${r.description}" [$(vm)]; welcome "Disconnected from the device." + Reconnect`;
});

await check('pairing rejected mid-session: views blank with Re-pair, status bar and device row say so, re-pairing restores', async () => {
  await run('decky-toolkit.connect', seedId());
  await settle();
  // Without a stats lease the /health poll checks the pairing itself (stats polling would take 5 s).
  const actions = tree('decky-toolkit.actions').view;
  actions.visible = false;
  actions._visibility.fire({ visible: false });
  device.rejectToken = true;
  await settle(150);
  assert.equal(calls.context.get('decky-toolkit.link'), 'rejected');
  for (const id of LOST_VIEWS) {
    assert.deepEqual(await tree(`decky-toolkit.${id}`).provider.getChildren(), []);
    assert.match(welcomeFor(`decky-toolkit.${id}`)[0], /no longer accepts this editor.*\n\[Reconnect\]\(command:decky-toolkit\.reconnect\)$/s);
  }
  assert.equal(status(), '$(key) 10.1.2.3: pairing rejected');
  assert.equal(calls.statusItems[0].backgroundColor.id, 'statusBarItem.errorBackground');
  const [r] = devicesProvider().getChildren();
  assert.equal(r.description, 'v0.2.0 · pairing rejected');
  const file = ext.deckyUri({ host: '10.1.2.3', port: 8765 }, '/home/jackh/.local/share/VVVVVV/saves/tsave.vvv');
  assert.equal(calls.decorations[0].provideFileDecoration(file).color.id, 'list.errorForeground');
  device.pairQueue = ['approved'];
  fetched.length = 0;
  await run('decky-toolkit.reconnect');
  await settle();
  assert.ok(fetched.includes('/pair/request'), 'Re-pair runs pairing');
  assert.equal(calls.context.get('decky-toolkit.link'), 'connected');
  assert.equal(status(), '$(vm-connect) 10.1.2.3');
  actions.visible = true;
  actions._visibility.fire({ visible: true });
  await run('decky-toolkit.disconnectDevice');
  await settle();
  return 'rejected → Re-pair → connected';
});

await check('Connect with a stored pairing checks /health and connects without pairing', async () => {
  fetched.length = 0;
  await run('decky-toolkit.connect', seedId());
  await settle();
  assert.ok(fetched.includes('/health'));
  assert.ok(!fetched.includes('/pair/request'));
  assert.equal(calls.context.get('decky-toolkit.connected'), true);
  assert.match(calls.statusMessages.at(-1), /Connected to 10\.1\.2\.3/);
  assert.equal(calls.panels.filter(x => !x.disposed).length, 0, 'screen opens only after the first connect of a session');
  await run('decky-toolkit.disconnectDevice');
  return `requests: ${[...new Set(fetched)].join(', ')}`;
});

await check('a forgotten pairing (401) goes straight into pairing', async () => {
  await ctx.secrets.store(identityKey, JSON.stringify({ ...pairedIdentity, cert: otherPki.cert }));
  await settle();
  fetched.length = 0;
  device.pairQueue = ['approved'];
  await run('decky-toolkit.connect', seedId());
  await settle();
  assert.ok(fetched.includes('/pair/request'));
  assertPaired();
  assert.equal(calls.context.get('decky-toolkit.connected'), true);
  await run('decky-toolkit.disconnectDevice');
  return `requests: ${fetched.join(', ')}`;
});

await check('a reset device (pinned certificate no longer matches) goes straight into pairing, no extra message', async () => {
  await ctx.secrets.store(identityKey, JSON.stringify({ ...pairedIdentity, serverCert: otherPki.cert }));
  await settle();
  fetched.length = 0;
  const before = calls.messages.length;
  device.pairQueue = ['approved'];
  await run('decky-toolkit.connect', seedId());
  await settle();
  assert.ok(fetched.includes('/pair/request'));
  assertPaired();
  assert.equal(calls.context.get('decky-toolkit.connected'), true);
  assert.deepEqual(calls.messages.slice(before).map(m => m.m), ['Decky Toolkit: Paired with 10.1.2.3.']);
  await run('decky-toolkit.disconnectDevice');
  return `requests: ${fetched.join(', ')}`;
});

await check('a pairing code that differs from our own derivation aborts with "could not pair"', async () => {
  await ctx.secrets.delete(identityKey);
  await settle();
  device.pairRequests = [];
  device.pairCancelled = [];
  device.tamperCode = true;
  let offered;
  ui.warning = (m, buttons) => { offered = { m, buttons }; return undefined; };
  await run('decky-toolkit.connect', seedId());
  await settle();
  device.tamperCode = false;
  assert.deepEqual(offered, { m: 'Decky Toolkit: could not pair with 10.1.2.3. Try again.', buttons: ['Try again'] });
  assert.equal(storedIdentity(), undefined);
  assert.deepEqual(device.pairCancelled, ['req0'], 'the request is withdrawn on the device');
  assert.equal(calls.context.get('decky-toolkit.connected'), false);
  await storePaired();
  await settle();
  return `"${offered.m}"`;
});

await check('a command while disconnected offers to connect instead of running', async () => {
  let offered;
  ui.warning = (m, buttons) => { offered = { m, buttons }; return undefined; };
  const copied = calls.clipboard.length;
  await run('decky-toolkit.copyMcpUrl');
  assert.equal(offered.m, 'Decky Toolkit: not connected to a device.');
  assert.deepEqual(offered.buttons, ['Connect to 10.1.2.3']);
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
  assert.deepEqual(calls.lastError.buttons, ['Retry'], 'no way to edit the address: forget and add the device again');
  assert.equal(row.description, 'v0.2.0 · unreachable');
  assert.equal(row.iconPath.id, 'warning');
  assert.equal(row.iconPath.color.id, 'problemsWarningIcon.foreground');
  assert.ok(!fetched.includes('/pair/request'));
  assert.equal(calls.context.get('decky-toolkit.connected'), true, 'Retry connected once the device answered');
  await run('decky-toolkit.disconnectDevice');
  return `"${calls.lastError.m}" [${calls.lastError.buttons.join(', ')}], row was "${row.description}"`;
});

await check('pairing denied on the device: "Pairing denied" with Try again, which files a new request', async () => {
  await ctx.secrets.delete(identityKey);
  await settle();
  device.pairRequests = [];
  device.pairQueue = ['pending', 'denied', 'approved'];
  const offered = [];
  ui.warning = (m, buttons) => { offered.push({ m, buttons }); return 'Try again'; };
  await run('decky-toolkit.connect', seedId());
  await settle();
  assert.deepEqual(offered, [{ m: 'Decky Toolkit: Pairing denied on 10.1.2.3.', buttons: ['Try again'] }]);
  assert.equal(device.pairRequests.length, 2, 'Try again filed a second request');
  assertPaired();
  assert.equal(calls.context.get('decky-toolkit.connected'), true);
  await run('decky-toolkit.disconnectDevice');
  return `"${offered[0].m}" [${offered[0].buttons.join(', ')}], then approved`;
});

await check('pairing has no time limit: survives a lost connection and a forgotten request (new code); Cancel sends DELETE', async () => {
  await ctx.secrets.delete(identityKey);
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
  const [code0, code1] = device.pairRequests.map(r => r.code);
  assert.equal(row.description, `v0.2.0 · waiting for approval · code ${code1}`, 'the row shows the new code');
  assert.ok(prog.messages.some(m => m === `Lost contact with 10.1.2.3 (cannot reach the device (socket hang up)), retrying… Code ${code0}.`));
  assert.equal(prog.messages.at(-1), `Waiting for approval on 10.1.2.3 · code ${code1}. On the device: Quick Access → Decky Toolkit → Approve.`);
  assert.deepEqual(device.pairCancelled, ['req1']);
  assert.equal(calls.messages.filter(m => m.kind === 'warning').length, warningsBefore, 'cancel is silent');
  assert.equal(calls.context.get('decky-toolkit.connected'), false);
  assert.equal(devicesProvider().getChildren()[0].description, 'v0.2.0 · not paired');
  return `${prog.messages.length} progress updates, codes ${code0} → ${code1}, DELETE ${device.pairCancelled[0]}`;
});

await check('a device with an older plugin (plain HTTP): "Update Decky Toolkit", no manual pairing', async () => {
  device.pairUnsupported = true;
  let offered;
  ui.warning = (m, buttons) => { offered = { m, buttons }; return undefined; };
  await run('decky-toolkit.connect', seedId());
  device.pairUnsupported = false;
  assert.equal(offered.m, 'Decky Toolkit: Update Decky Toolkit on 10.1.2.3 to pair with it.');
  assert.deepEqual(offered.buttons, []);
  assert.equal(devicesProvider().getChildren()[0].description, 'v0.2.0 · not paired');
  return `"${offered.m}" [${offered.buttons.join(', ')}]`;
});

await check('Add device with one saved: "Replace?" modal; Cancel keeps it, Replace forgets it and its pairing', async () => {
  const prompts = [];
  ui.inputBox = opts => { prompts.push(opts.prompt); return undefined; };
  await run('decky-toolkit.addDevice');
  const modal = lastMessage('warning');
  assert.deepEqual({ m: modal.m, buttons: modal.buttons, options: modal.options }, {
    m: 'Replace 10.1.2.3?', buttons: ['Replace'],
    options: { modal: true, detail: 'Its pairing is deleted. This editor connects to one device at a time.' },
  });
  assert.equal(prompts.length, 0, 'Cancel: no address prompt');
  assert.equal(globalState.get('decky-toolkit.devices').length, 1);

  await storePaired();
  await run('decky-toolkit.connect', seedId());
  await settle();
  assert.equal(calls.context.get('decky-toolkit.connected'), true);
  const oldId = seedId();
  const inputs = ['10.9.9.9', '', '9000'];
  ui.warning = (m, buttons) => (m === 'Replace 10.1.2.3?' ? 'Replace' : undefined);
  ui.inputBox = opts => { prompts.push(opts.prompt); if (opts.validateInput) assert.equal(opts.validateInput(inputs[0]), undefined); return inputs.shift(); };
  const picks = ['port', 'later'];
  const offered = [];
  ui.quickPick = items => { offered.push(items.map(i => i.label)); const want = picks.shift(); return items.find(i => i.id === want); };
  await run('decky-toolkit.addDevice');
  await settle();
  const list = globalState.get('decky-toolkit.devices');
  assert.equal(list.length, 1, 'exactly one saved device');
  assert.notEqual(list[0].id, oldId);
  assert.deepEqual({ name: list[0].name, host: list[0].host, port: list[0].port }, { name: '10.9.9.9', host: '10.9.9.9', port: 9000 });
  assert.equal(storedIdentity(), undefined, 'the old pairing is deleted');
  assert.equal(calls.context.get('decky-toolkit.connected'), false, 'the old session ended');
  assert.equal(prompts.length, 3);
  assert.match(offered[0][0], /Connect to 10\.9\.9\.9/);
  assert.match(offered[0][1], /Change port \(8765\)/);
  ui.inputBox = opts => opts.validateInput('http://x/');
  await run('decky-toolkit.refresh');
  await settle();
  const rows = devicesProvider().getChildren();
  assert.deepEqual(rows.map(r => [r.label, r.description]), [['10.9.9.9:9000', 'unreachable']], 'refresh probes the saved device');

  // Back to the seed address for the checks that follow.
  ui.warning = (_m, buttons) => buttons[0];
  ui.inputBox = opts => (opts.prompt.startsWith('IP address') ? '10.1.2.3' : '');
  ui.quickPick = items => items.find(i => i.id === 'later');
  await run('decky-toolkit.addDevice');
  await settle();
  assert.deepEqual(globalState.get('decky-toolkit.devices').map(d => `${d.host}:${d.port}`), ['10.1.2.3:8765']);
  await storePaired();
  await settle();
  return `modal "${modal.m}" [${modal.buttons.join(', ')}]; prompts: ${prompts.join(' / ')}; then picks ${offered[0].join(' | ')}`;
});

await check('status bar: device actions QuickPick (disconnect, open screen, rename, forget); no Switch device', async () => {
  await run('decky-toolkit.connect', seedId());
  await settle();
  let offered;
  ui.quickPick = (items, opts) => { offered = { labels: items.map(i => i.label), placeHolder: opts.placeHolder }; return undefined; };
  assert.equal(calls.statusItems[0].command, 'decky-toolkit.deviceActions');
  await run('decky-toolkit.deviceActions');
  assert.equal(offered.placeHolder, '10.1.2.3 · connected');
  assert.deepEqual(offered.labels, [
    '$(debug-disconnect) Disconnect from 10.1.2.3', '$(device-desktop) Open screen', '', '$(pencil) Rename…', '$(trash) Forget device']);
  assert.equal(calls.statusItems[0].tooltip, 'Decky: connected to 10.1.2.3 (10.1.2.3:8765). Click for device actions');
  await run('decky-toolkit.disconnectDevice');
  await run('decky-toolkit.deviceActions');
  assert.deepEqual(offered.labels.slice(0, 2), ['$(plug) Connect to 10.1.2.3', '']);
  assert.ok(!calls.commands.has('decky-toolkit.switchDevice'), 'no switchDevice command');
  assert.deepEqual(pkg.contributes.commands.filter(c => /switch/i.test(c.command) || /switch device/i.test(c.title)), [], 'package.json contributes no Switch device');
  await run('decky-toolkit.connect', seedId());
  await settle();
  return offered.labels.filter(Boolean).join(' | ');
});

await check('the … overflow menu: only Rename and Forget device; no manual pairing anywhere', async () => {
  let offered;
  ui.quickPick = items => { offered = items.map(i => i.label); };
  await run('decky-toolkit.deviceActions', seedId());
  assert.deepEqual(offered.map(l => l.replace(/^\$\([^)]+\) /, '')), ['Rename…', 'Forget device']);
  for (const id of ['decky-toolkit.enterToken', 'decky-toolkit.pairAgain', 'decky-toolkit.changeHost', 'decky-toolkit.editDevice', 'decky-toolkit.disconnect']) {
    assert.ok(!calls.commands.has(id), `${id} is gone`);
  }
  assert.doesNotMatch(JSON.stringify(pkg.contributes), /Re-pair|Enter token|token manually/);
  ui.inputBox = opts => { assert.equal(opts.value, '10.1.2.3'); return '  Living room Deck  '; };
  await run('decky-toolkit.renameDevice', seedId());
  assert.equal(globalState.get('decky-toolkit.devices')[0].name, 'Living room Deck');
  const [row] = devicesProvider().getChildren();
  assert.equal(row.label, 'Living room Deck');
  assert.match(row.description, /^10\.1\.2\.3:8765 · v0\.2\.0 · /);
  ui.inputBox = () => '10.1.2.3';
  await run('decky-toolkit.renameDevice', seedId());
  return offered.join(' | ');
});

await check('Games view with fake clients: Proton title with saves, native title, shortcut, 404 device, errors', async () => {
  const device = { id: 'g', name: 'Deck', host: '10.0.70.18', port: 8765 };
  const fakeConn = client => ({ connectedDevice: device, link: 'connected', authedClient: () => client, onDidChangeTarget: new EventEmitter().event, label: 'Deck' });
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
  const unpaired = new ext.GamesTreeProvider({ ...fakeConn(undefined), connectedDevice: undefined, link: undefined });
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
  const fs = new ext.DeckyFileSystemProvider({ devices, identityFor: async d => (d.host === '10.1.2.4' ? undefined : pairedIdentity) });
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

  const raw = await deviceFetch(`https://10.1.2.3:8765/fs?path=${encodeURIComponent(`${VV}/saves/slot2`)}`, { method: 'DELETE', identity: pairedIdentity });
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

// Captured from avahi-publish on the Bazzite device answering a legacy unicast PTR query (2026-11-04).
const AVAHI_ANSWER = Buffer.from('1234840000010005000000000e5f6465636b792d746f6f6c6b6974045f746370056c6f63616c00000c0001c00c000c00010000000a000a0762617a7a697465c00cc037001000010000000a001c0769643d61626364056170693d310d76657273696f6e3d302e322e30c037002100010000000a001000000000223d0762617a7a697465c020c07b001c00010000000a0010fe800000000000001d7a890bd48de1ebc07b000100010000000a00040a004612', 'hex');
const toolkitHealth = (hostname, version = '0.3.0', extra = {}) => ({ ok: true, name: 'decky-toolkit', version, api_version: 1, tools: 60, hostname, device_id: `id-${hostname}`, os: 'SteamOS', ...extra });
const legacyHealth = { ok: true, name: 'decky-mcp', version: '0.2.0', api_version: 1, tools: 51 };
const useFakeLan = () => {
  net.interfaces = {
    lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1', netmask: '255.0.0.0' }],
    eth0: [{ family: 'IPv4', internal: false, address: '10.0.70.30', netmask: '255.255.255.0' }, { family: 'IPv6', internal: false, address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::' }],
    wlan0: [{ family: 'IPv4', internal: false, address: '10.1.2.50', netmask: '255.255.255.0' }, { family: 'IPv4', internal: false, address: '169.254.3.4', netmask: '255.255.0.0' }],
    corp0: [{ family: 'IPv4', internal: false, address: '10.8.0.2', netmask: '255.255.0.0' }],
    docker0: [{ family: 'IPv4', internal: false, address: '172.17.0.1', netmask: '255.255.0.0' }],
    'br-2c0a796fe934': [{ family: 'IPv4', internal: false, address: '10.5.0.1', netmask: '255.255.255.0' }],
  };
  net.hosts = new Map([
    ['10.0.70.18:8765', toolkitHealth('bazzite.internal', '0.3.0', { os: 'Bazzite' })],
    ['10.0.70.40:8765', legacyHealth],
    ['10.0.70.41:8765', { ok: true, name: 'some-other-service', version: '1.0' }],
    ['10.0.70.42:8765', '<html>router login</html>'],
    ['10.1.2.3:8765', toolkitHealth('steamdeck')],
  ]);
  net.slow = new Set(['10.0.70.99']);
  net.mdns = [[AVAHI_ANSWER, '10.0.70.18']];
};
const groupNode = () => devicesProvider().getChildren().find(n => n.contextValue === 'discovery.group');

await check('discovery: mDNS packet parsing (avahi capture) and interface/subnet selection', async () => {
  const recs = ext.parseMessage(AVAHI_ANSWER);
  assert.deepEqual(recs.map(r => r.type), [12, 16, 33, 1], 'AAAA skipped');
  const services = ext.assembleServices(recs.map(r => ({ ...r, from: '10.0.70.18' })));
  assert.deepEqual(services, [{ instance: 'bazzite', host: '10.0.70.18', port: 8765, txt: { id: 'abcd', api: '1', version: '0.2.0' } }]);
  assert.throws(() => ext.parseMessage(AVAHI_ANSWER.subarray(0, 60)));
  const q = ext.encodeQuery('_decky-toolkit._tcp.local', 12);
  assert.equal(q.subarray(12).toString('hex'), AVAHI_ANSWER.subarray(12, q.length).toString('hex'), 'same question avahi echoed');
  useFakeLan();
  const ifaces = ext.usableInterfaces(net.interfaces);
  assert.deepEqual(ifaces.map(i => `${i.name} ${i.address}/${i.prefix}`), ['eth0 10.0.70.30/24', 'wlan0 10.1.2.50/24', 'corp0 10.8.0.2/16']);
  const { subnets, hosts } = ext.sweepTargets(ifaces);
  assert.deepEqual(subnets, ['10.0.70.0/24', '10.1.2.0/24'], 'a /16 is too wide to sweep');
  assert.equal(hosts.length, 2 * 253, 'network, broadcast and own address skipped');
  assert.ok(!hosts.includes('10.0.70.30') && hosts.includes('10.0.70.1') && hosts.includes('10.0.70.254') && !hosts.includes('10.0.70.255'));
  return `${recs.length} records; ${ifaces.length} usable interfaces; sweep ${subnets.join(', ')}`;
});

await check('discovery: off → no group and no Search network action', async () => {
  assert.equal(groupNode(), undefined);
  assert.deepEqual(titleMenu('decky-toolkit.devices'), ['decky-toolkit.addDevice', 'decky-toolkit.refresh']);
  calls.context.set('config.decky-toolkit.discovery.enabled', true);
  try {
    assert.deepEqual(titleMenu('decky-toolkit.devices'), ['decky-toolkit.addDevice', 'decky-toolkit.searchNetwork', 'decky-toolkit.refresh']);
  } finally {
    calls.context.delete('config.decky-toolkit.discovery.enabled');
  }
  const cmd = pkg.contributes.commands.find(c => c.command === 'decky-toolkit.searchNetwork');
  assert.deepEqual([cmd.title, cmd.icon], ['Search network', '$(search)']);
  assert.equal(pkg.contributes.configuration.properties['decky-toolkit.discovery.enabled'].default, true);
  return 'title: Add, Search network, Refresh';
});

await check('discovery: Search network finds devices via mDNS and the subnet sweep, ignores the rest', async () => {
  net.probed.length = 0;
  net.queries.length = 0;
  await vscode.workspace.getConfiguration('decky-toolkit').update('discovery.enabled', true);
  assert.equal(groupNode().iconPath.id, 'radio-tower', 'turning it on does not scan by itself');
  tree('decky-toolkit.devices').view._visibility.fire({ visible: true });
  assert.equal(groupNode().iconPath.id, 'loading~spin', 'opening the Devices view scans');
  const scan = run('decky-toolkit.searchNetwork');
  await settle(5);
  const busy = groupNode();
  assert.equal(busy.iconPath.id, 'loading~spin');
  assert.equal(busy.description, 'searching…');
  await scan;
  assert.deepEqual(net.queries.map(q => [q.iface, q.addr, q.port]), [['10.0.70.30', '224.0.0.251', 5353], ['10.1.2.50', '224.0.0.251', 5353], ['10.8.0.2', '224.0.0.251', 5353]]);
  assert.ok(net.probed.every(h => /^10\.(0\.70|1\.2)\.\d+:8765$/.test(h)), 'only the two local /24s, port 8765');
  assert.ok(net.probed.includes('10.0.70.99:8765'), 'slow host probed and timed out');
  const g = groupNode();
  assert.equal(g.label, 'On this network');
  assert.equal(g.iconPath.id, 'radio-tower');
  assert.equal(g.description, '3 found');
  assert.equal(g.collapsibleState, 2);
  assert.deepEqual(itemMenu('decky-toolkit.devices', g.contextValue, true), ['decky-toolkit.searchNetwork']);
  const kids = devicesProvider().getChildren(g);
  assert.deepEqual(kids.map(k => [k.label, k.description, k.iconPath.id, k.contextValue]), [
    ['bazzite', '10.0.70.18 · v0.3.0', 'vm', 'deck.found'],
    ['10.0.70.40', '10.0.70.40 · v0.2.0', 'vm', 'deck.found'],
    ['steamdeck', '10.1.2.3 · v0.3.0 · saved', 'pass', 'deck.found.saved'],
    ['Add a device by address…', undefined, 'add', 'discovery.add'],
  ], 'the saved 10.1.2.3 is marked; the other service, the HTML page and the slow host are left out');
  assert.deepEqual(kids[2].command, { command: 'decky-toolkit.connect', title: 'Connect', arguments: [seedId()] }, 'the saved one connects, no replace');
  assert.match(kids[2].tooltip.value, /Saved as \*\*10\.1\.2\.3\*\*/);
  assert.deepEqual(itemMenu('decky-toolkit.devices', 'deck.found.saved', true), [], 'no Add on the saved one');
  assert.deepEqual(itemMenu('decky-toolkit.devices', 'deck.found.saved', false), []);
  assert.match(kids[0].tooltip.value, /Decky Toolkit 0\.3\.0, API v1 · Bazzite/);
  assert.match(kids[1].tooltip.value, /decky-mcp 0\.2\.0/);
  assert.deepEqual(kids[0].command, { command: 'decky-toolkit.connectFound', title: 'Connect', arguments: ['10.0.70.18:8765'] });
  assert.deepEqual(itemMenu('decky-toolkit.devices', 'deck.found', true), ['decky-toolkit.connectFound']);
  assert.deepEqual(itemMenu('decky-toolkit.devices', 'deck.found', false), ['decky-toolkit.connectFound']);
  assert.equal(kids[3].command.command, 'decky-toolkit.addDevice');
  return `${kids.length - 1} found from ${net.probed.length} probes and ${net.queries.length} mDNS queries`;
});

await check('discovery engine: found/lost events, throttled start, stop, probe cap', async () => {
  const d = new ext.DeviceDiscovery(() => []);
  const events = [];
  d.onDidChange(e => events.push({ found: e.found.map(x => x.key), lost: e.lost.map(x => x.key) }));
  await d.rescan();
  assert.deepEqual(events.at(-1).found.sort(), ['10.0.70.18:8765', '10.0.70.40:8765', '10.1.2.3:8765']);
  assert.equal(d.devices.find(x => x.key === '10.0.70.18:8765').via, 'mdns');
  net.hosts.delete('10.0.70.40:8765');
  net.hosts.set('10.1.2.77:8765', toolkitHealth('steamdeck-2'));
  // Same device_id at a second address (Wi-Fi + Ethernet) is listed once.
  net.hosts.set('10.1.2.78:8765', toolkitHealth('steamdeck-2'));
  await d.rescan();
  assert.deepEqual(events.at(-1), { found: ['10.1.2.77:8765'], lost: ['10.0.70.40:8765'] });
  const n = net.probed.length;
  d.start();
  assert.equal(d.scanning, false, 'start() right after a scan does nothing');
  assert.equal(net.probed.length, n);
  const pending = d.rescan();
  assert.equal(d.scanning, true);
  d.stop();
  await pending;
  assert.equal(d.scanning, false);
  assert.ok(d.devices.some(x => x.key === '10.1.2.77:8765'), 'stop keeps the previous results');
  ext.discoveryTimings.maxProbes = 300;
  try {
    await d.rescan();
    assert.equal(d.lastScan.truncated, true);
    assert.equal(d.lastScan.probes, 300 + 1, 'capped sweep plus one mDNS hit');
  } finally {
    ext.discoveryTimings.maxProbes = 1024;
  }
  d.dispose();
  net.hosts.delete('10.1.2.77:8765');
  net.hosts.delete('10.1.2.78:8765');
  net.hosts.set('10.0.70.40:8765', legacyHealth);
  return JSON.stringify(events);
});

await check('discovery: Add on a found device asks to replace the saved one; Replace saves it alone, deletes the old pairing and pairs', async () => {
  await storePaired();
  await settle();
  const oldId = seedId();
  const reqs = device.pairRequests.length;
  let kids = devicesProvider().getChildren(groupNode());
  await run('decky-toolkit.connectFound', kids[0]);
  await settle();
  assert.equal(lastMessage('warning').m, 'Replace 10.1.2.3?');
  assert.deepEqual(globalState.get('decky-toolkit.devices').map(d => d.id), [oldId], 'Cancel: unchanged');
  assert.ok(storedIdentity(), 'Cancel keeps the pairing');
  assert.equal(device.pairRequests.length, reqs, 'no pairing request');

  device.pairQueue = ['approved'];
  ui.warning = (_m, buttons) => buttons[0];
  kids = devicesProvider().getChildren(groupNode());
  await run('decky-toolkit.connectFound', kids[0]);
  await settle();
  const list = globalState.get('decky-toolkit.devices');
  assert.equal(list.length, 1, 'exactly one saved device');
  assert.deepEqual({ ...list[0], id: undefined }, { id: undefined, name: 'bazzite', host: '10.0.70.18', port: 8765 });
  assert.equal(storedIdentity(), undefined, 'the replaced device\'s pairing is deleted');
  assert.equal(device.pairRequests.length, reqs + 1, 'a pairing request was filed');
  assertPaired('decky-toolkit.identity:10.0.70.18:8765');
  const marked = devicesProvider().getChildren(groupNode()).find(k => k.label === 'bazzite');
  assert.equal(marked.contextValue, 'deck.found.saved', 'the saved device is marked in the group');
  assert.ok(devicesProvider().getChildren(groupNode()).some(k => k.label === 'steamdeck' && k.contextValue === 'deck.found'), 'the replaced one is just found now');
  const rows = devicesProvider().getChildren().filter(r => r.device);
  assert.deepEqual(rows.map(r => [r.device.host, r.contextValue]), [['10.0.70.18', 'deck.session']]);
  return `replaced 10.1.2.3 with ${list[0].name} and paired`;
});

await check('discovery: hasDevices stays true while only found devices are listed; turning discovery off', async () => {
  ui.warning = () => 'Remove';
  for (const d of globalState.get('decky-toolkit.devices')) await run('decky-toolkit.removeDevice', d.id);
  await settle();
  assert.deepEqual(globalState.get('decky-toolkit.devices'), []);
  assert.equal(calls.context.get('decky-toolkit.hasDevices'), true, 'the found 10.0.70.40 and 10.1.2.3 keep the tree');
  assert.deepEqual(devicesProvider().getChildren().map(n => n.contextValue), ['discovery.group']);
  await vscode.workspace.getConfiguration('decky-toolkit').update('discovery.enabled', false);
  assert.deepEqual(devicesProvider().getChildren(), []);
  assert.equal(calls.context.get('decky-toolkit.hasDevices'), false);
  ui.warning = () => undefined;
  await run('decky-toolkit.searchNetwork');
  assert.match(lastMessage('info').m, /network discovery is turned off/);
  assert.equal(groupNode(), undefined);
  return 'hasDevices true → false';
});

await check('decky:// reports reachability to the connection; decorations mark files of a device that cannot serve them', async () => {
  const zed = { id: 'z', name: 'Zed', host: '10.9.9.9', port: 8765 };
  const notes = [];
  const fs = new ext.DeckyFileSystemProvider({ devices: [zed], identityFor: async () => pairedIdentity, noteReachable: (d, ok) => notes.push([d.id, ok]) });
  const err = await fs.readFile(ext.deckyUri(zed, '/home/x')).catch(e => e);
  assert.equal(err.code, 'Unavailable');
  assert.deepEqual(notes, [['z', false]]);
  let status = 'unreachable';
  const statusChanged = new EventEmitter();
  const state = { devices: [zed], connectedDevice: undefined, rejected: false, statusOf: () => status, onDidChangeStatus: statusChanged.event };
  const deco = new ext.DeckyFileDecorations(state);
  let fired = 0;
  deco.onDidChangeFileDecorations(() => fired++);
  const uri = ext.deckyUri(zed, '/home/x');
  const lost = deco.provideFileDecoration(uri);
  assert.deepEqual([lost.badge, lost.color.id], ['!', 'list.warningForeground']);
  assert.match(lost.tooltip, /^Lost connection to Zed/);
  status = 'disconnected';
  statusChanged.fire();
  assert.equal(fired, 1, 'a status change redraws the decorations');
  assert.equal(deco.provideFileDecoration(uri), undefined, 'paired and reachable: no mark, even without a session');
  status = 'unpaired';
  assert.match(deco.provideFileDecoration(uri).tooltip, /^Not paired with Zed/);
  assert.match(deco.provideFileDecoration(ext.deckyUri({ host: '10.4.4.4', port: 8765 }, '/a')).tooltip, /^No saved Decky device 10\.4\.4\.4/);
  assert.equal(deco.provideFileDecoration(Uri.from({ scheme: 'file', path: '/a' })), undefined);
  deco.dispose();
  return 'connection error → noteReachable(false); unreachable / unpaired / unknown device marked, reachable not';
});

// transport.ts against a real HTTPS server holding the throwaway device certificate. It requests a client
// certificate without requiring one, as the plugin does (pairing and /health come without one).
const tlsLog = [];
const tlsServer = https.createServer({ key: serverPki.key, cert: serverPki.cert, ca: [serverPki.cert], requestCert: true, rejectUnauthorized: false }, async (req, res) => {
  const peer = req.socket.getPeerCertificate();
  const chunks = [];
  for await (const c of req) chunks.push(c);
  tlsLog.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks), client: peer?.fingerprint256, authorized: req.socket.authorized });
  if (req.url === '/sse') {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: one\n\n');
    const t = setInterval(() => res.write('data: tick\n\n'), 20);
    res.on('close', () => { clearInterval(t); tlsLog.push({ closed: '/sse' }); });
    return;
  }
  if (req.url === '/slow') return void setTimeout(() => res.end('late'), 2000);
  if (req.url === '/empty') return void res.writeHead(204).end();
  res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': ['a=1', 'b=2'] }).end(JSON.stringify({ ok: true, path: req.url }));
});
tlsServer.on('upgrade', (req, socket) => {
  tlsLog.push({ upgrade: req.url, client: req.socket.getPeerCertificate()?.fingerprint256, headers: req.headers });
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
  socket.on('data', d => socket.write(Buffer.concat([Buffer.from('echo:'), d])));
});
await new Promise(r => tlsServer.listen(0, '127.0.0.1', r));
const tlsPort = tlsServer.address().port;
const tlsUrl = p => `https://127.0.0.1:${tlsPort}${p}`;
const clientFp = new X509Certificate(clientCertPem).fingerprint256;
/** Runs `fn` with the real HTTPS transport instead of the fake device. */
async function withRealTransport(fn) {
  ext.transportHooks.fetch = realDeviceFetch;
  try {
    return await fn();
  } finally {
    ext.transportHooks.fetch = deviceFetch;
  }
}

await check('transport: paired requests pin the device and present the client certificate; bodies and headers round-trip', async () => {
  tlsLog.length = 0;
  const res = await realDeviceFetch(tlsUrl('/x?q=1'), { identity: pairedIdentity, method: 'POST', body: 'hello', headers: { 'Content-Type': 'text/plain' } });
  assert.ok(res instanceof Response);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, path: '/x?q=1' });
  assert.equal(res.headers.get('set-cookie'), 'a=1, b=2');
  assert.equal(tlsLog[0].client, clientFp, 'the server saw our client certificate');
  assert.equal(tlsLog[0].authorized, true, 'signed by the device');
  assert.equal(tlsLog[0].body.toString(), 'hello');
  assert.equal(tlsLog[0].headers.authorization, undefined, 'no bearer header');
  await (await realDeviceFetch(tlsUrl('/bin'), { identity: pairedIdentity, method: 'PUT', body: new Uint8Array([1, 2, 3]) })).text();
  assert.deepEqual([...tlsLog[1].body], [1, 2, 3]);
  assert.equal(tlsLog[1].headers['content-length'], '3');
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array([9, 8, 7])], { type: 'application/zip' }), 'p.zip');
  await (await realDeviceFetch(tlsUrl('/form'), { identity: pairedIdentity, method: 'POST', body: form })).text();
  assert.match(tlsLog[2].headers['content-type'], /^multipart\/form-data; boundary=/);
  assert.match(tlsLog[2].body.toString('latin1'), /filename="p\.zip"\r\nContent-Type: application\/zip\r\n\r\n\x09\x08\x07\r\n/);
  const empty = await realDeviceFetch(tlsUrl('/empty'), { identity: pairedIdentity });
  assert.equal(empty.status, 204);
  assert.equal(await empty.text(), '');
  const client = new ext.DeckyClient({ host: '127.0.0.1', port: tlsPort }, pairedIdentity);
  assert.equal((await withRealTransport(() => client.health())).path, '/health', 'DeckyClient goes through it');
  return `client cert ${clientFp.slice(0, 11)}… seen; string, bytes, multipart, 204`;
});

await check('transport: a device whose certificate does not match the pin fails with TrustError', async () => {
  const wrong = await realDeviceFetch(tlsUrl('/x'), { identity: { ...pairedIdentity, serverCert: otherPki.cert } }).catch(e => e);
  assert.ok(wrong instanceof ext.TrustError, `got ${wrong}`);
  assert.equal(wrong.cause?.code, 'DEPTH_ZERO_SELF_SIGNED_CERT');
  // Same chain, different fingerprint: the pin check itself.
  const pin = ext.tlsOptions(pairedIdentity).checkServerIdentity;
  assert.ok(pin('10.1.2.3', { fingerprint256: 'AA:BB' }) instanceof ext.TrustError);
  assert.equal(pin('10.1.2.3', { fingerprint256: serverPeer.fingerprint256 }), undefined, 'an IP address is fine: the pin replaces hostname checks');
  const viaClient = new ext.DeckyClient({ host: '127.0.0.1', port: tlsPort }, { ...pairedIdentity, serverCert: otherPki.cert });
  assert.ok((await withRealTransport(() => viaClient.streamStats().catch(x => x))) instanceof ext.TrustError);
  return `${wrong.name}: ${wrong.message}`;
});

await check('transport: unpaired requests accept any certificate and expose it for the pairing code', async () => {
  tlsLog.length = 0;
  const res = await realDeviceFetch(tlsUrl('/health'));
  assert.equal(res.status, 200);
  await res.text();
  assert.equal(res.peerCert.fingerprint256, serverPeer.fingerprint256);
  assert.deepEqual(res.peerCert.der, serverPeer.der);
  assert.equal(res.peerCert.pem.replace(/\s/g, ''), serverPki.cert.replace(/\s/g, ''), 'PEM rebuilt from DER');
  assert.equal(ext.fingerprint(res.peerCert.der), serverPeer.fingerprint256);
  assert.equal(ext.fingerprint(res.peerCert.pem), serverPeer.fingerprint256);
  assert.equal(tlsLog[0].client, undefined, 'no client certificate before pairing');
  return res.peerCert.fingerprint256.slice(0, 11) + '…';
});

await check('transport: SSE bodies stream before the response ends; abort tears the request down', async () => {
  tlsLog.length = 0;
  const ac = new AbortController();
  const res = await realDeviceFetch(tlsUrl('/sse'), { identity: pairedIdentity, signal: ac.signal });
  const reader = res.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.equal(first, 'data: one\n\n', 'first event arrives while the stream is open');
  await reader.read();
  ac.abort();
  const after = await reader.read().catch(e => e);
  assert.ok(after instanceof Error && after.name === 'AbortError', `body read after abort: ${after?.name ?? JSON.stringify(after)}`);
  for (let i = 0; i < 50 && !tlsLog.some(l => l.closed); i++) await settle(10);
  assert.ok(tlsLog.some(l => l.closed === '/sse'), 'the server saw the connection close');
  const early = new AbortController();
  const pending = realDeviceFetch(tlsUrl('/slow'), { identity: pairedIdentity, signal: early.signal });
  setTimeout(() => early.abort(), 30);
  assert.equal((await pending.catch(x => x)).name, 'AbortError', 'abort before the response rejects like fetch');
  const timedOut = await realDeviceFetch(tlsUrl('/slow'), { identity: pairedIdentity, signal: AbortSignal.timeout(30) }).catch(x => x);
  assert.equal(timedOut.name, 'TimeoutError');
  const pre = await realDeviceFetch(tlsUrl('/x'), { signal: AbortSignal.abort() }).catch(x => x);
  assert.equal(pre.name, 'AbortError');
  return 'event before end, AbortError mid-body and before the answer, TimeoutError';
});

await check('transport: an older plugin answering in plain HTTP is "unsupported", not unreachable', async () => {
  const plain = http.createServer((_q, r) => r.end('{"ok":true}'));
  await new Promise(r => plain.listen(0, '127.0.0.1', r));
  const port = plain.address().port;
  try {
    const e = await realDeviceFetch(`https://127.0.0.1:${port}/health`).catch(x => x);
    assert.ok(ext.isPlainHttpDevice(e), `${e?.cause?.code}`);
    const client = new ext.DeckyClient({ host: '127.0.0.1', port });
    const pem = clientKeys.publicKey.export({ type: 'spki', format: 'pem' });
    assert.equal(await withRealTransport(() => client.requestPairing('x', pem)), 'unsupported');
    const refused = await realDeviceFetch('https://127.0.0.1:1/health').catch(x => x);
    assert.equal(refused.cause?.code, 'ECONNREFUSED', 'connection errors keep the fetch shape');
    assert.equal(refused.message, 'fetch failed');
  } finally {
    plain.close();
  }
  return 'EPROTO → unsupported; ECONNREFUSED → fetch failed';
});

await check('proxy: stable port (next free when taken), persisted prefix, HTTPS upstream with the pairing, WebSocket', async () => {
  const blocker = http.createServer();
  await new Promise(r => blocker.listen(0, '127.0.0.1', r));
  const taken = blocker.address().port;
  const state = new Map();
  const memento = { get: k => state.get(k), update: async (k, v) => { state.set(k, v); } };
  const target = { host: '127.0.0.1', port: tlsPort, identity: pairedIdentity };
  const proxy = new ext.DeviceProxy(() => target, memento, () => taken);
  const wrong = new ext.DeviceProxy(() => ({ ...target, identity: { ...pairedIdentity, serverCert: otherPki.cert } }), memento, () => 0);
  try {
    const base = await proxy.start();
    const secret = state.get('decky-toolkit.proxySecret');
    assert.ok(secret && secret.length >= 20);
    assert.equal(base, `http://127.0.0.1:${taken + 1}/${secret}`, 'next port after the taken one');
    assert.equal(await proxy.mcpUrl(), `${base}/mcp`);
    assert.equal(await proxy.rebase(`http://127.0.0.1:${taken + 7}/${secret}/mcp`), `${base}/mcp`);
    assert.equal(await proxy.rebase(`http://localhost:${taken + 7}/${secret}/mcp`), `${base}/mcp`);
    assert.equal(await proxy.rebase(`${base}/mcp`), undefined, 'already right');
    assert.equal(await proxy.rebase(`http://127.0.0.1:${taken + 7}/other/mcp`), undefined, 'not ours');
    assert.equal(await proxy.rebase('https://10.1.2.3:8765/mcp'), undefined);

    tlsLog.length = 0;
    const res = await new Promise((resolve, reject) => {
      const q = http.request(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer x' } }, resolve);
      q.on('error', reject);
      q.end('{"jsonrpc":"2.0"}');
    });
    let text = '';
    for await (const c of res) text += c;
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(text), { ok: true, path: '/mcp' });
    assert.equal(tlsLog[0].client, clientFp, 'upstream presents the client certificate');
    assert.equal(tlsLog[0].headers.authorization, undefined, 'no authorization header upstream');
    assert.equal(tlsLog[0].body.toString(), '{"jsonrpc":"2.0"}');

    const echoed = await new Promise((resolve, reject) => {
      const q = http.request(`${base}/input`, { headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': 'x', 'sec-websocket-version': '13' } });
      q.on('upgrade', (r, sock) => { sock.write('ping'); sock.once('data', d => { sock.destroy(); resolve([r.statusCode, d.toString()]); }); });
      q.on('error', reject);
      q.end();
    });
    assert.deepEqual(echoed, [101, 'echo:ping']);
    assert.equal(tlsLog.find(l => l.upgrade)?.client, clientFp, 'the WebSocket upgrade presents it too');

    const wrongBase = await wrong.start();
    assert.equal(wrongBase.split('/').pop(), secret, 'the prefix survives a restart');
    const bad = await new Promise((resolve, reject) => http.get(`${wrongBase}/health`, resolve).on('error', reject));
    bad.resume();
    assert.equal(bad.statusCode, 502, 'a device that does not match the pin is not reached');
  } finally {
    proxy.stop();
    wrong.stop();
    blocker.close();
  }
  return `taken ${taken} → ${taken + 1}`;
});

await check('no unexpected error messages', async () => {
  assert.deepEqual(calls.unexpectedErrors, []);
});

for (const d of ctx.subscriptions) d.dispose?.();
ext.deactivate();
tlsServer.closeAllConnections();
tlsServer.close();
const failed = results.filter(r => !r).length;
console.log(failed ? `\n${failed} check(s) failed` : `\nall ${results.length} smoke checks passed`);
process.exit(failed ? 1 : 0);
