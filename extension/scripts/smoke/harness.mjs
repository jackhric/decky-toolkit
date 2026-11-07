// Shared by the smoke areas: the stub `vscode` module, the extension bundle, the fake device and helpers.
import * as esbuild from 'esbuild';
import assert from 'assert/strict';
import Module, { createRequire } from 'module';
import { execFileSync } from 'child_process';
import { X509Certificate, createHash, createPublicKey, generateKeyPairSync } from 'crypto';
import * as http from 'http';
import * as https from 'https';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { hostname, tmpdir } from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const root = path.resolve(here, '..', '..');
export const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
export const clientSrc = path.resolve(root, '..', 'packages', 'client', 'src');
// The identity file lives here for the whole run, never in the real ~/.config.
export const configDir = mkdtempSync(path.join(tmpdir(), 'decky-smoke-config-'));
process.env.DECKY_TOOLKIT_CONFIG_DIR = configDir;
export const identityPath = path.join(configDir, 'identity.json');

const outfile = path.join(root, 'out', 'smoke.cjs');
await esbuild.build({
  stdin: {
    contents: "export * from './src/extension'; export * from './src/actionsTree'; export * from './src/pluginsTree'; " +
      "export * from '../packages/client/src/deploy'; export * from '../packages/client/src/stage'; export { AUTO_DEPLOY_DEBOUNCE_MS } from './src/deploy'; " +
      "export * from './src/controllers'; export * from './src/navigation'; export { DeckyClient, HttpError, eventTimings } from '../packages/client/src/client'; " +
      "export * from './src/games'; export * from './src/remoteFs'; export * from './src/discovery'; export * from '../packages/client/src/transport'; " +
      "export { pairingCode } from './src/pairing'; export { DeviceProxy } from './src/proxy'; export { Connection } from './src/connection'; " +
      "export * as identityFile from '../packages/client/src/identity';",
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
export const serverPki = selfSigned('server');
export const otherPki = selfSigned('other');
export const clientKeys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const clientKeyPem = clientKeys.privateKey.export({ type: 'pkcs8', format: 'pem' });
writeFileSync(path.join(certDir, 'client.key'), clientKeyPem);
writeFileSync(path.join(certDir, 'client.ext'), 'extendedKeyUsage=clientAuth\nkeyUsage=digitalSignature\n');
ossl('req', '-new', '-key', 'client.key', '-subj', '/CN=VS Code on smoke', '-out', 'client.csr');
ossl('x509', '-req', '-in', 'client.csr', '-CA', 'server.crt', '-CAkey', 'server.key', '-CAcreateserial', '-days', '2', '-extfile', 'client.ext', '-out', 'client.crt');
const clientCertPem = readFileSync(path.join(certDir, 'client.crt'), 'utf8');
const peerOf = pem => { const x = new X509Certificate(pem); return { der: x.raw, pem, fingerprint256: x.fingerprint256 }; };
export const serverPeer = peerOf(serverPki.cert);
const deviceCode = (publicKeyPem, id) => {
  const spki = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  const d = createHash('sha256').update(Buffer.concat([serverPeer.der, spki, Buffer.from(id)])).digest();
  return String(d.readUInt32BE(0) % 10000).padStart(4, '0');
};
// What a completed pairing stores; the fake device accepts requests that present this client certificate.
export const pairedIdentity = { key: clientKeyPem, cert: clientCertPem, serverCert: serverPki.cert };

class TabInputWebview { constructor(viewType) { this.viewType = viewType; } }
// A screen tab left behind by an earlier extension host (VS Code prefixes the view type).
export const orphanGroup = { viewColumn: 2, isActive: false, tabs: [] };
orphanGroup.tabs.push({ group: orphanGroup, isActive: true, input: new TabInputWebview('mainThreadWebview-decky-toolkit.screen') });
const tabGroups = [orphanGroup];

export const calls = {
  treeViews: [], treeProviders: [], webviewProviders: [], commands: new Map(), context: new Map(), statusItems: [], executed: [],
  panels: [], closedTabs: [], progress: [], messages: [], statusMessages: [], clipboard: [], unexpectedErrors: [], opened: [], written: [], saveDialogs: [],
  watchers: [], output: [], fsProviders: [], folderUpdates: [], docs: [], revealed: [], decorations: [], channels: new Map(),
};

export class EventEmitter {
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
export class Disposable { constructor(fn) { this.fn = fn; } dispose() { this.fn?.(); } }
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
export class RelativePattern { constructor(base, pattern) { this.base = base; this.pattern = pattern; } }
export const Uri = {
  parse: s => ({ toString: () => s, path: new URL(s).pathname }),
  file: p => ({ toString: () => `file://${p}`, path: p, fsPath: p }),
  joinPath: (u, ...p) => ({ toString: () => [u.toString(), ...p].join('/'), path: [u.path ?? '', ...p].join('/'), fsPath: [u.fsPath ?? u.path ?? '', ...p].join('/') }),
  from: ({ scheme, authority = '', path: p = '' }) => ({ scheme, authority, path: p, toString: () => `${scheme}://${authority}${p}` }),
};
export const files = new Map();

// UI answers, replaced per check. Every message is logged; an unexpected error message fails the run.
export const ui = {};
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
export const settings = { host: '10.1.2.3', port: 8765, pluginDirName: '', 'deploy.build': 'never', 'discovery.enabled': false };
export const configEmitter = new EventEmitter();
const workspaceFolders = new EventEmitter();
const noop = async () => undefined;
export const noopEvent = () => new Disposable();
export const vscode = {
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
        fire: uri => change.fire(uri), dispose() { this.disposed = true; },
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
export const ext = createRequire(import.meta.url)(outfile);

const secretsEmitter = new EventEmitter();
export const secrets = new Map();
export const globalState = new Map();
export const ctx = {
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
export const health = { ok: true, name: 'decky-toolkit', version: '0.2.0', api: ['v1'], tools: 15 };
export const stats = { available: true, running: true, subscribers: 1, fps: 30, kbps: 19542, frames_total: 10, uptime_s: 1, width: 1920, height: 1080, settings: { fps: 30, quality: 70, width: 0, audio: true }, error: null };
const streamLimits = { fps: [1, 60], quality: [10, 100], widths: [0, 1600, 1280, 960, 640], audio: [false, true] };
export const plugins = [
  { dir: 'decky-toolkit', name: 'Decky Toolkit', author: 'jackh', flags: ['root', 'debug'], api_version: 1, version: '0.1.0', has_backend: true },
  { dir: 'romm-tender', name: 'Tender', author: 'x', flags: [], api_version: 1, version: '0.33.0', has_backend: true },
];
export const setPlugins = list => plugins.splice(0, plugins.length, ...list);
export const device = { pairQueue: [], pairRequests: [], pairCancelled: [], pairUnsupported: false, installs: [], journal: ['boot'], pluginLog: {}, installMeta: { name: 'My Plugin', version: '1.2.3' }, downFor: 0, input: { enabled: false, backend: 'ei', available: true, reason: null } };
// Going down or forgetting this client ends its open streams, as on the device.
let deviceUp = true, rejectToken = false;
Object.defineProperties(device, {
  up: { get: () => deviceUp, set: v => { deviceUp = v; if (!v) evEnd(); }, enumerable: true },
  rejectToken: { get: () => rejectToken, set: v => { rejectToken = v; if (v) evEnd(); }, enumerable: true },
});
export const frameJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
// Controllers and Steam UI routes as in the API contract.
export const steamDeck = { id: 'evdev:deck', name: 'Steam Deck', kind: 'physical', virtual_id: null, vendor: '28de', product: '1205', device: '/dev/input/event5', steam: { type: 'steamdeck', slot: 0, name: 'Steam Deck' } };
export const ctl = {
  refuse: null, nextId: 1, posts: [],
  controllers: [steamDeck, { id: 'evdev:auto', name: 'Decky Toolkit pad', kind: 'virtual', virtual_id: 'auto0', vendor: '045e', product: '028e', device: '/dev/input/event9', steam: { type: 'xbox360', slot: 1, name: 'Xbox 360 Controller' } }],
  virtual: [{ id: 'auto0', name: 'Decky Toolkit pad', type: 'x360', created_at: 1, last_event_at: 2, auto: true }],
};
// `/events`: `streams` are the open bodies; `status` other than 200 refuses new ones; `silent` ones get no hello.
export const ev = { status: 200, silent: false, streams: new Set(), opened: 0 };
export const evState = () => ({
  tools: { hash: 'h1' },
  stream_settings: { ...stats.settings, limits: streamLimits },
  input_settings: device.input,
  plugins: { plugins: plugins.map(({ dir, name, version }) => ({ dir, name, version })) },
  controllers: { controllers: ctl.controllers, virtual: ctl.virtual },
  pairing: { pending: 0, paired: 1 },
});
const evFrame = (name, data) => new TextEncoder().encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
export const evPush = (name, data) => { for (const c of ev.streams) c.enqueue(evFrame(name, data)); };
export const ctlPush = () => evPush('controllers', { controllers: ctl.controllers, virtual: ctl.virtual });
/** Ends every open stream: cleanly, after `shutdown`, or as a dropped connection. */
export const evEnd = (how = 'drop') => {
  for (const c of ev.streams) {
    try {
      if (how === 'shutdown') c.enqueue(evFrame('shutdown', {}));
      if (how === 'drop') c.error(Object.assign(new TypeError('terminated'), { cause: { code: 'ECONNRESET' } }));
      else c.close();
    } catch { /* closed */ }
  }
  ev.streams.clear();
};
export const uiRoutes = {
  current: '/library/home',
  official: [{ path: '/library/home', title: 'Library' }, { path: '/library/app/{appid}', title: 'Game details', template: true }, { path: '/settings', title: 'Settings' }],
  plugins: [{ plugin: 'Tender', path: '/tender', title: 'Tender' }],
  quick_access_tabs: ['Notifications', 'Decky'],
};
export const uiDevice = { posts: [], toasts: [] };
// Library and game folders as the device reports them (Bazzite: Steam paths under /var/home, ~ is /home).
export const ago = s => new Date(Date.now() - s * 1000).toISOString().replace(/\.\d+Z$/, '+00:00');
export const STEAM = '/var/home/jackh/.local/share/Steam';
export const CT_USER = `${STEAM}/steamapps/compatdata/2567870/pfx/drive_c/users/steamuser`;
const appVVVVVV = {
  appid: 70300, name: 'VVVVVV', type: 'game', installed: true, running: true, install_dir: `${STEAM}/steamapps/common/vvvvvv`,
  compat_tool: 'steamlinuxruntime_sniper', compat_tool_display: 'Steam Linux Runtime 3.0', size_on_disk: 75883262, library: STEAM, last_played: ago(300),
};
const appChained = {
  appid: 2567870, name: 'Chained Together', type: 'game', installed: true, running: false, install_dir: `${STEAM}/steamapps/common/ChainedTogether`,
  compat_tool: 'proton_11', compat_tool_display: 'Proton 11.0-2', size_on_disk: 8493964009, library: STEAM, last_played: ago(3700),
};
export const appRom = {
  appid: 4289220546, name: '1080° Avalanche', type: 'shortcut', installed: true, running: false, install_dir: '/home/jackh/.local/share/romm-tender/bin',
  compat_tool: null, compat_tool_display: null, size_on_disk: 0, library: null, last_played: null,
};
const appRemote = { ...appChained, appid: 220, name: 'Half-Life 2', installed: false, last_played: ago(10) };
const entry = (path, exists = true) => ({ path, exists, ...(exists ? { mtime: ago(9000) } : {}) });
const userDirs = (base, present, matches = {}) => Object.fromEntries([
  ['appdata_roaming', 'AppData/Roaming'], ['appdata_local', 'AppData/Local'], ['appdata_locallow', 'AppData/LocalLow'],
  ['documents', 'Documents'], ['saved_games', 'Saved Games'],
].map(([k, rel]) => [k, { ...entry(`${base}/${rel}`, present.includes(k)), matches: matches[k] ?? [] }]));
export const dirsChained = {
  appid: 2567870, name: 'Chained Together', platform: 'proton', compat_tool: 'proton_11', steam_root: STEAM,
  install_dir: entry(`${STEAM}/steamapps/common/ChainedTogether`), compatdata: entry(`${STEAM}/steamapps/compatdata/2567870`),
  prefix: entry(`${STEAM}/steamapps/compatdata/2567870/pfx`),
  prefix_user_dirs: userDirs(CT_USER, ['appdata_roaming', 'appdata_local', 'documents', 'saved_games'], { appdata_local: [`${CT_USER}/AppData/Local/ChainedTogether`] }),
  account_id: '95599472', userdata: entry(`${STEAM}/userdata/95599472/2567870`), cloud_remote: entry(`${STEAM}/userdata/95599472/2567870/remote`, false),
  shader_cache: entry(`${STEAM}/steamapps/shadercache/2567870`), xdg: [],
};
export const savesChained = {
  appid: 2567870, name: 'Chained Together', steam_cloud: [], notes: [],
  candidates: [
    { path: `${CT_USER}/AppData/Local/ChainedTogether/Saved/SaveGames/Progress.sav`, size: 30519, mtime: ago(3650), found_by: 'steam_cloud remotecache (root 3)', rank: 0, score: 0 },
    { path: `${CT_USER}/AppData/Local/ChainedTogether/Saved/SaveGames/Save.sav`, size: 2348, mtime: ago(20000), found_by: 'steam_cloud remotecache (root 3)', rank: 0, score: 0 },
    { path: `${CT_USER}/AppData/Local/ChainedTogether/Saved/Config/Windows/GameUserSettings.ini`, size: 900, mtime: ago(20000), found_by: 'heuristic: under a dir named after the game', rank: 2, score: 3 },
  ],
};
export const dirsVVVVVV = {
  appid: 70300, name: 'VVVVVV', platform: 'native', compat_tool: 'steamlinuxruntime_sniper', steam_root: STEAM,
  install_dir: entry(`${STEAM}/steamapps/common/vvvvvv`), compatdata: entry(`${STEAM}/steamapps/compatdata/70300`),
  prefix: entry(`${STEAM}/steamapps/compatdata/70300/pfx`, false), prefix_user_dirs: userDirs(`${STEAM}/steamapps/compatdata/70300/pfx/drive_c/users/steamuser`, []),
  account_id: '95599472', userdata: entry(`${STEAM}/userdata/95599472/70300`), cloud_remote: entry(`${STEAM}/userdata/95599472/70300/remote`, false),
  shader_cache: entry(`${STEAM}/steamapps/shadercache/70300`), xdg: [{ ...entry('/home/jackh/.local/share/VVVVVV'), base: '/home/jackh/.local/share' }],
};
export const savesVVVVVV = {
  appid: 70300, name: 'VVVVVV', steam_cloud: [], notes: [],
  candidates: [
    { path: '/home/jackh/.local/share/VVVVVV/saves/unlock.vvv', size: 2214, mtime: ago(320), found_by: 'steam_cloud remotecache (root 2)', rank: 0, score: 0 },
    { path: '/home/jackh/.local/share/VVVVVV/saves/tsave.vvv', size: 2523, mtime: ago(400000), found_by: 'steam_cloud remotecache (root 2)', rank: 0, score: 0 },
    { path: '/home/jackh/.local/share/VVVVVV/saves/settings.vvv', size: 1675, mtime: ago(320), found_by: 'steam_autocloud.vdf marker in dir', rank: 1, score: 0 },
  ],
};
export const games = {
  calls: [],
  apps: [appRom, appChained, appVVVVVV, appRemote],
  dirs: { 70300: dirsVVVVVV, 2567870: dirsChained },
  saves: { 70300: savesVVVVVV, 2567870: savesChained },
};

// In-memory device file system behind the /fs routes, with the server's guards: login files are refused,
// writes only under ~/.local/share/VVVVVV, DELETE needs confirm=1.
export const fakeFs = { nodes: new Map(), log: [] };
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

export const fetched = [];
// Requests to /mcp: the extension itself never makes one (only external MCP clients through its proxy do).
export const mcpCalls = [];
export const fail = (status, error) => { throw { status, error }; };
// The client API routes the extension uses beyond pairing, streams and files: [method, path pattern, handler].
// A handler gets the match, the JSON body and the query; `fail` answers with a status and {"error"}.
const deviceRoutes = [
  ['GET', /^\/stream\/stats$/, () => stats],
  ['GET', /^\/stream\/settings$/, () => (device.streamSettingsMissing ? fail(404, 'capture not available') : { ...stats.settings, limits: streamLimits })],
  ['PUT', /^\/stream\/settings$/, (_m, body) => {
    if (device.streamSettingsMissing) fail(404, 'capture not available');
    device.streamPuts = [...(device.streamPuts ?? []), body];
    stats.settings = { ...stats.settings, ...body };
    evPush('stream_settings', { ...stats.settings, limits: streamLimits });
    return { ...stats.settings, limits: streamLimits };
  }],
  ['GET', /^\/stream\/frame$/, () => new Response(frameJpeg, { headers: { 'content-type': 'image/jpeg' } })],
  ['GET', /^\/input\/settings$/, () => device.input],
  ['PUT', /^\/input\/settings$/, (_m, body) => {
    device.input = { ...device.input, enabled: body.enabled };
    evPush('input_settings', device.input);
    return device.input;
  }],
  ['GET', /^\/plugins$/, () => plugins],
  ['POST', /^\/plugins\/reload$/, (_m, body) => {
    const { plugin: name, mode = 'backend' } = body;
    device.liveReloads = [...(device.liveReloads ?? []), { plugin: name, mode }];
    return { dir: plugins.find(p => p.name === name)?.dir ?? name, name, mode, load_ms: 9, reloaded: true, errors: [], restored: ['panel'], routes: [] };
  }],
  ['POST', /^\/loader\/restart$/, () => ({ restarting: true, delay_s: 1 })],
  ['GET', /^\/logs\/tail$/, (_m, _b, q) => {
    const dir = q.get('plugin'), tail = Number(q.get('tail') ?? 100);
    if (!dir) return { lines: device.journal.slice(-tail) };
    return device.pluginLog[dir] ? { lines: device.pluginLog[dir].slice(-tail) } : fail(404, 'no log dir');
  }],
  ['GET', /^\/controllers$/, () => ({ controllers: ctl.controllers, virtual: ctl.virtual, input_enabled: device.input.enabled })],
  ['POST', /^\/controllers\/virtual$/, (_m, req) => {
    ctl.posts.push(req);
    if (ctl.refuse) fail(503, ctl.refuse);
    if (ctl.virtual.filter(v => !v.auto).length >= 4) fail(400, 'all 4 virtual controller slots are in use');
    const id = `v${ctl.nextId++}`;
    const name = req.name ?? `Virtual pad ${ctl.nextId - 1}`;
    ctl.virtual.push({ id, name, type: 'x360', created_at: 3, last_event_at: null, auto: false });
    ctl.controllers.push({ id: `evdev:${id}`, name, kind: 'virtual', virtual_id: id, vendor: '045e', product: '028e', device: `/dev/input/event1${ctl.nextId}`, steam: { type: 'xbox360', slot: ctl.controllers.length, name: 'Xbox 360 Controller' } });
    ctlPush();
    return { id, name, type: 'x360' };
  }],
  ['DELETE', /^\/controllers\/virtual\/([^/]+)$/, m => {
    const id = decodeURIComponent(m[1]);
    if (!ctl.virtual.some(v => v.id === id)) fail(404, `no virtual gamepad '${id}'`);
    ctl.virtual = ctl.virtual.filter(v => v.id !== id);
    ctl.controllers = ctl.controllers.filter(c => c.virtual_id !== id);
    ctlPush();
    return { removed: id };
  }],
  ['GET', /^\/ui\/routes$/, () => uiRoutes],
  ['POST', /^\/ui\/navigate$/, (_m, body) => {
    uiDevice.posts.push(body);
    if (body.path && !/^\/(library|settings|tender)/.test(body.path)) fail(400, `unknown path ${body.path}`);
    if (body.path) uiRoutes.current = body.path;
    return { ok: true, current: body.path ?? (body.action === 'plugin' ? `/quickaccess/${body.plugin}` : uiRoutes.current) };
  }],
  ['POST', /^\/ui\/toast$/, (_m, body) => { uiDevice.toasts.push(body); return { result: 'ok' }; }],
  ['POST', /^\/cef\/evaluate$/, (_m, body) => ({ value: body.expression === 'window.DeckyPluginLoader?.version' ? 'v3.3.1' : null })],
  ['GET', /^\/apps$/, () => ({ count: games.apps.length, apps: games.apps })],
  ['GET', /^\/apps\/(\d+)\/(dirs|saves)$/, m => games[m[2]][m[1]] ?? fail(404, 'app is not in this Steam library')],
  ['GET', /^\/apps\/(\d+)\/proton-log$/, m => ({
    appid: Number(m[1]),
    proton_log: { path: `/home/jackh/steam-${m[1]}.log`, exists: false, hint: 'set the launch option PROTON_LOG=1 %command% and run the game to create it' },
    steam_logs: [{ file: `${STEAM}/logs/compat_log.txt`, mtime: ago(60), lines: [`StartSession: appID ${m[1]}`] }],
  })],
  ['POST', /^\/apps\/(\d+)\/(launch|terminate)$/, (m, body) => {
    const appid = Number(m[1]);
    games.calls.push({ action: m[2], appid, body });
    return m[2] === 'launch' ? { appid, name: 'Chained Together', launched: true, running: true } : { appid, name: 'VVVVVV', terminated: true, running: false };
  }],
];

export const deviceFetch = async (url, init = {}) => {
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
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  // The client API lives under /api/v1 (recorded without the prefix); only /health and /mcp stay at the top level.
  if (u.pathname.startsWith('/api/v1/')) u = new URL(u.origin + u.pathname.slice('/api/v1'.length) + u.search);
  else if (u.pathname === '/mcp') { mcpCalls.push(init.body); return json({ jsonrpc: '2.0', id: null, error: { code: -32601, message: 'not in this fake' } }); }
  else if (u.pathname !== '/health') return new Response('404: Not Found', { status: 404 });
  fetched.push(u.pathname);
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
    if (next === 'approved') return json({ status: 'approved', client_cert: clientCertPem, server_cert: serverPki.cert });
    if (next === 'pending') await new Promise(r => setTimeout(r, 5));
    return json({ status: next });
  }
  if (!authed || device.rejectToken) return new Response('unauthorized', { status: 401 });
  if (u.pathname === '/plugins/install' && init.method === 'POST') {
    const file = init.body.get('file');
    const dir = file.name.replace(/\.zip$/, '');
    const restart = u.searchParams.get('restart');
    device.installs.push({ dir, restart, bytes: file.size });
    const meta = device.installMeta;
    const loaded = `2026-11-04T00:00:00-05:00 bazzite PluginLoader[1]: [loader][INFO]: Loaded ${meta.name} (v${meta.version})`;
    if (!plugins.some(x => x.dir === dir)) plugins.push({ dir, name: meta.name, version: meta.version, flags: [], has_backend: true });
    if (restart === 'plugin') device.journal.push(`${loaded} #${device.installs.length}`);
    // The watcher queues one reload per changed file.
    if (restart === 'none') for (const ms of [100, 400]) setTimeout(() => device.journal.push(`${loaded} #${device.installs.length}.${ms}`), ms);
    if (restart === 'loader') device.downFor = 1;
    evPush('plugins', evState().plugins);
    device.pluginLog[dir] = [...(device.pluginLog[dir] ?? []), `[INFO]: ${meta.name} started #${device.installs.length}`];
    return json({ installed: { dir, name: meta.name, version: meta.version }, restarted: restart });
  }
  if (u.pathname === '/events') {
    if (ev.status !== 200) return json({ error: 'events unavailable' }, ev.status);
    ev.opened++;
    let c;
    const body = new ReadableStream({
      start(ctrl) {
        c = ctrl;
        ev.streams.add(ctrl);
        if (!ev.silent) ctrl.enqueue(evFrame('hello', { version: health.version, api: ['v1'], state: evState() }));
      },
      cancel() { ev.streams.delete(c); },
    });
    init.signal?.addEventListener('abort', () => { ev.streams.delete(c); try { c.error(new DOMException('aborted', 'AbortError')); } catch { /* closed */ } });
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  }
  for (const [method, pattern, handler] of deviceRoutes) {
    const m = (init.method ?? 'GET') === method && pattern.exec(u.pathname);
    if (!m) continue;
    try {
      const value = handler(m, typeof init.body === 'string' ? JSON.parse(init.body) : {}, u.searchParams);
      return value instanceof Response ? value : json(value);
    } catch (e) {
      if (e?.status) return json({ error: e.error }, e.status);
      throw e;
    }
  }
  if (u.pathname === '/fs' || u.pathname.startsWith('/fs/')) return fsRoute(u, init, json);
  const files = /^\/plugins\/([^/]+)\/files$/.exec(u.pathname);
  if (files && init.method === 'PUT') {
    device.filePuts = [...(device.filePuts ?? []), { dir: decodeURIComponent(files[1]), path: u.searchParams.get('path'), bytes: init.body.length }];
    return json({ dir: decodeURIComponent(files[1]), path: u.searchParams.get('path'), bytes: init.body.length });
  }
  return new Response('not found', { status: 404 });
};
globalThis.fetch = deviceFetch;
export const realDeviceFetch = ext.transportHooks.fetch;
ext.transportHooks.fetch = deviceFetch;

// Minimal when-clause evaluator: ==, !=, =~ /re/, !, &&, ||, parentheses (&& binds tighter).
export function evalWhen(expr, context) {
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
export const welcomeFor = (view, context = calls.context) => pkg.contributes.viewsWelcome.filter(w => w.view === view && evalWhen(w.when, context)).map(w => w.contents);
export const visibleViews = (context = calls.context) => pkg.contributes.views['decky-toolkit'].filter(v => evalWhen(v.when, context)).map(v => v.id);
export const itemMenu = (view, viewItem, inline) => pkg.contributes.menus['view/item/context']
  .filter(m => (m.group ?? '').startsWith('inline') === inline)
  .filter(m => evalWhen(m.when, new Map([...calls.context, ['view', view], ['viewItem', viewItem]])))
  .map(m => m.command);

export const results = [];
export async function check(name, fn) {
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
export const settle = (ms = 50) => new Promise(r => setTimeout(r, ms));
export const labels = items => items.map(i => i.label);
export const run = (id, ...args) => calls.commands.get(id)(...args);
// Pairings live in the identity file; `secrets` only when it cannot be written.
const identityKey = 'decky-toolkit.identity:10.1.2.3:8765';
export const readIdentityFile = () => (existsSync(identityPath) ? JSON.parse(readFileSync(identityPath, 'utf8')) : undefined);
export function storedIdentity(k = identityKey) {
  const f = readIdentityFile();
  if (!f || `${identityKey.split(':')[0]}:${f.device.host}:${f.device.port}` !== k) return undefined;
  return { key: f.key, cert: f.cert, serverCert: f.serverCert };
}
/** What another process (the CLI) does: an atomic write of the file the extension watches. */
export function writeIdentity(identity, device = { host: '10.1.2.3', port: 8765, name: '10.1.2.3' }) {
  const tmp = `${identityPath}.ext.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, device, ...identity }), { mode: 0o600 });
  renameSync(tmp, identityPath);
}
export const removeIdentity = () => rmSync(identityPath, { force: true });
export const storePaired = async () => { writeIdentity(pairedIdentity); };
/** The identity a pairing stored: the device's certificates and the private key generated for it. */
export function assertPaired(k = identityKey) {
  const id = storedIdentity(k);
  assert.ok(id, `no identity stored under ${k}`);
  assert.equal(id.cert, clientCertPem);
  assert.equal(id.serverCert.replace(/\s/g, ''), serverPki.cert.replace(/\s/g, ''), 'pins the certificate the device presented');
  assert.match(id.key, /^-----BEGIN PRIVATE KEY-----/);
  return id;
}
export const lastMessage = kind => calls.messages.filter(m => m.kind === kind).at(-1);

ext.connectionTimings.healthPollMs = 40;
ext.connectionTimings.retryMs = 20;
ext.pairingTimings.retryMs = 20;
ext.identityFile.identityTimings.debounceMs = 5;
ext.eventTimings.backoffMs = [10, 20, 40];

// Fake LAN for discovery: interfaces, a /health per host and an mDNS responder behind a fake socket.
export const net = {
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

/** Runs `fn` with the identity file in a throwaway directory, so the main run's file stays untouched. */
export async function inOtherConfigDir(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'decky-smoke-config2-'));
  process.env.DECKY_TOOLKIT_CONFIG_DIR = dir;
  try {
    return await fn(dir, path.join(dir, 'identity.json'));
  } finally {
    process.env.DECKY_TOOLKIT_CONFIG_DIR = configDir;
  }
}

export const tree = id => calls.treeViews.find(t => t.id === id);
export const actionsProvider = () => tree('decky-toolkit.actions').provider;
export const pluginsProvider = () => tree('decky-toolkit.plugins').provider;
export const devicesProvider = () => tree('decky-toolkit.devices').provider;
export const status = () => calls.statusItems[0].text;
export const seedId = () => globalState.get('decky-toolkit.devices')[0].id;
export const titleMenu = view => pkg.contributes.menus['view/title'].filter(m => evalWhen(m.when, new Map([...calls.context, ['view', view]]))).map(m => m.command);
export const dupes = list => list.filter((x, i) => list.indexOf(x) !== i);

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
export async function actionsTree() {
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

export const scratch = mkdtempSync(path.join(tmpdir(), 'decky-smoke-'));
export const put = (root, rel, text = '', mode = 0o644) => {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), text, { mode });
};
/** A decky-plugin-template checkout, trimmed. */
export function makePlugin(root, { name = 'My Plugin', flags = [], version = '1.2.3', build = 'rollup -c', lock = 'pnpm-lock.yaml' } = {}) {
  put(root, 'plugin.json', JSON.stringify({ name, author: 'me', flags, api_version: 1 }, null, 2) + '\n');
  put(root, 'package.json', JSON.stringify({ name: 'x', version, scripts: { build } }, null, 2) + '\n');
  if (lock) put(root, lock);
  put(root, 'main.py', 'class Plugin: pass\n');
  put(root, 'src/index.tsx', 'export default 1;\n');
  put(root, 'dist/index.js', 'export default 1;\n');
  return root;
}
export const setMtime = (root, rel, secondsAgo) => {
  const t = new Date(Date.now() - secondsAgo * 1000);
  utimesSync(path.join(root, rel), t, t);
};
export async function openWorkspace(...folders) {
  vscode.workspace.workspaceFolders = folders.length ? folders.map(f => ({ name: path.basename(f), uri: Uri.file(f) })) : undefined;
  workspaceFolders.fire();
  await settle(300);
}
export const statusButton = () => calls.statusItems.find(i => /Deploy|Deploying/.test(i.text));
export const output = () => calls.output.join('');

// The real media/screen.js in a minimal DOM: what the webview does with the extension's messages.
export function loadScreenJs({ live } = {}) {
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
export const titleActions = (panelId = 'decky-toolkit.screen') => pkg.contributes.menus['editor/title']
  .filter(m => evalWhen(m.when, new Map([...calls.context, ['activeWebviewPanelId', panelId]]))).map(m => m.command);
export const icon = id => pkg.contributes.commands.find(c => c.command === id).icon;
// Answers QuickPicks in order by label (prefix match); records what was offered.
export function answerPicks(...labels) {
  const offered = [];
  ui.quickPick = (items, opts) => {
    offered.push({ labels: items.map(i => i.label), descriptions: items.map(i => i.description), opts });
    const want = labels.shift();
    return want === undefined ? undefined : items.find(i => i.label === want || i.label.endsWith(' ' + want));
  };
  return offered;
}

export const LOST_VIEWS = ['actions', 'plugins', 'games', 'controllers'];
export const lostNotes = () => (calls.channels.get('Decky Loader') ?? []).filter(l => l.startsWith('[decky-toolkit]'));

// Captured from avahi-publish on the Bazzite device answering a legacy unicast PTR query (2026-11-04).
export const AVAHI_ANSWER = Buffer.from('1234840000010005000000000e5f6465636b792d746f6f6c6b6974045f746370056c6f63616c00000c0001c00c000c00010000000a000a0762617a7a697465c00cc037001000010000000a001c0769643d61626364056170693d310d76657273696f6e3d302e322e30c037002100010000000a001000000000223d0762617a7a697465c020c07b001c00010000000a0010fe800000000000001d7a890bd48de1ebc07b000100010000000a00040a004612', 'hex');
export const toolkitHealth = (hostname, version = '0.3.0', extra = {}) => ({ ok: true, name: 'decky-toolkit', version, api: ['v1'], tools: 60, hostname, device_id: `id-${hostname}`, os: 'SteamOS', ...extra });
export const oldHealth = { ok: true, name: 'decky-toolkit', version: '0.2.0', tools: 51 };
export const useFakeLan = () => {
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
    ['10.0.70.40:8765', oldHealth],
    ['10.0.70.43:8765', { ok: true, name: 'decky-mcp', version: '0.2.0', tools: 51 }],
    ['10.0.70.41:8765', { ok: true, name: 'some-other-service', version: '1.0' }],
    ['10.0.70.42:8765', '<html>router login</html>'],
    ['10.1.2.3:8765', toolkitHealth('steamdeck')],
  ]);
  net.slow = new Set(['10.0.70.99']);
  net.mdns = [[AVAHI_ANSWER, '10.0.70.18']];
};
export const groupNode = () => devicesProvider().getChildren().find(n => n.contextValue === 'discovery.group');

// transport.ts against a real HTTPS server holding the throwaway device certificate. It requests a client
// certificate without requiring one, as the plugin does (pairing and /health come without one).
export const tlsLog = [];
export const tlsServer = https.createServer({ key: serverPki.key, cert: serverPki.cert, ca: [serverPki.cert], requestCert: true, rejectUnauthorized: false }, async (req, res) => {
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
export const tlsPort = tlsServer.address().port;
export const tlsUrl = p => `https://127.0.0.1:${tlsPort}${p}`;
export const clientFp = new X509Certificate(clientCertPem).fingerprint256;
/** Runs `fn` with the real HTTPS transport instead of the fake device. */
export async function withRealTransport(fn) {
  ext.transportHooks.fetch = realDeviceFetch;
  try {
    return await fn();
  } finally {
    ext.transportHooks.fetch = deviceFetch;
  }
}
