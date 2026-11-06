import * as vscode from 'vscode';
import type { AppSummary, FsEntry, GameDirs, GameSaves, ProtonLog, SaveCandidate } from '@decky-toolkit/client/api';
import { DeckyClient, describeError } from '@decky-toolkit/client/client';
import type { Connection, ConnectionState, SavedDevice } from './connection';
import { deckyUri, deviceAuthority, globEscape } from './remoteFs';

const MAX_SAVE_LOCATIONS = 8;

/** `Proton 11`, `Proton Experimental`, `Linux runtime` or `native`. */
export function runtimeLabel(app: Pick<AppSummary, 'compat_tool' | 'compat_tool_display'>): string {
  const tool = app.compat_tool ?? '';
  if (!tool) return 'native';
  if (/^steamlinuxruntime/i.test(tool)) return 'Linux runtime';
  const official = /^proton_(\w+)$/i.exec(tool);
  if (official) {
    const v = official[1];
    return `Proton ${/^\d+$/.test(v) ? v : v[0].toUpperCase() + v.slice(1)}`;
  }
  return app.compat_tool_display || tool;
}

export function isProton(app: Pick<AppSummary, 'compat_tool'>): boolean {
  return !!app.compat_tool && !/^steamlinuxruntime/i.test(app.compat_tool);
}

export function gameName(app: Pick<AppSummary, 'name' | 'appid'>): string {
  return app.name || `App ${app.appid}`;
}

/** Most recently played first; never-played titles after, by name. */
export function sortGames(apps: AppSummary[]): AppSummary[] {
  const t = (a: AppSummary) => (a.last_played ? Date.parse(a.last_played) : 0);
  return apps.filter(a => a.installed).sort((a, b) => t(b) - t(a) || gameName(a).localeCompare(gameName(b)));
}

export function formatSize(bytes: number | null | undefined): string {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '';
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return iso.slice(0, 10);
}

export interface GamePick extends vscode.QuickPickItem {
  app: AppSummary;
}

/** Items for "Find game…": every installed title, last played first; VS Code fuzzy-matches the label. */
export function buildGamePicks(apps: AppSummary[], now = Date.now()): GamePick[] {
  return sortGames([...apps]).map(app => ({
    label: `$(${app.running ? 'play-circle' : 'game'}) ${gameName(app)}`,
    description: runtimeLabel(app) + (app.type === 'shortcut' ? ' · non-Steam' : ''),
    detail: [`${app.appid}`, app.running ? 'running' : app.last_played ? `played ${relativeTime(app.last_played, now)}` : 'never played',
      app.size_on_disk ? formatSize(app.size_on_disk) : ''].filter(Boolean).join(' · '),
    app,
  }));
}

export class GameNode extends vscode.TreeItem {
  parentNode?: GameNode;
  /** Lazily loaded children. */
  load?: () => Promise<GameNode[]>;
  app?: AppSummary;
  /** Device path for folder and file rows. */
  devicePath?: string;
  isDir?: boolean;
  /** Workspace folder name for "Open in Explorer". */
  explorerName?: string;
  device?: SavedDevice;
  /** Names of the save files in this folder, highlighted in its listing. */
  saveFiles?: Set<string>;
}

function info(label: string, icon = 'info', description?: string): GameNode {
  const n = new GameNode(label);
  n.iconPath = new vscode.ThemeIcon(icon);
  n.description = description;
  n.contextValue = 'placeholder';
  return n;
}

function child(parent: GameNode, n: GameNode): GameNode {
  n.parentNode = parent;
  n.app ??= parent.app;
  n.device ??= parent.device;
  return n;
}

/** Steam reports /var/home/<user> on Fedora atomic systems, the server's ~ is /home/<user>. */
function homeVariants(steamRoot: string | undefined): string[] {
  const m = steamRoot && /^(.*)\/\.local\/share\/Steam$|^(.*)\/\.steam\/steam$/.exec(steamRoot);
  const home = m ? (m[1] ?? m[2]) : undefined;
  if (!home) return [];
  const alt = home.startsWith('/var/home/') ? home.slice(4) : home.startsWith('/home/') ? `/var${home}` : undefined;
  return alt ? [home, alt] : [home];
}

export function prettyPath(path: string, dirs?: Pick<GameDirs, 'steam_root' | 'prefix'>): string {
  const pfx = dirs?.prefix?.path;
  const user = pfx ? `${pfx}/drive_c/users/steamuser/` : undefined;
  if (user && path.startsWith(user)) return path.slice(user.length);
  for (const h of homeVariants(dirs?.steam_root)) {
    if (path === h) return '~';
    if (path.startsWith(`${h}/`)) return `~${path.slice(h.length)}`;
  }
  return path;
}

function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}

function basename(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1);
}

export interface SaveLocation {
  dir: string;
  files: SaveCandidate[];
  rank: number;
  newest: string | null;
}

/** Save candidates grouped by folder, best ranked folder first. */
export function saveLocations(saves: GameSaves): SaveLocation[] {
  const byDir = new Map<string, SaveLocation>();
  for (const c of saves.candidates) {
    const dir = dirname(c.path);
    const loc = byDir.get(dir) ?? { dir, files: [], rank: c.rank, newest: null };
    loc.files.push(c);
    loc.rank = Math.min(loc.rank, c.rank);
    if (c.mtime && (!loc.newest || c.mtime > loc.newest)) loc.newest = c.mtime;
    byDir.set(dir, loc);
  }
  return [...byDir.values()].sort((a, b) => a.rank - b.rank || (b.newest ?? '').localeCompare(a.newest ?? ''));
}

/** The folder "Open save data…" opens: the best save location, else the game's data dirs. */
export function bestSaveFolder(saves: GameSaves | undefined, dirs: GameDirs | undefined): string | undefined {
  const loc = saves && saveLocations(saves)[0];
  if (loc) return loc.dir;
  if (!dirs) return undefined;
  const matches = Object.values(dirs.prefix_user_dirs ?? {}).flatMap(d => d.matches ?? []);
  return matches[0] ?? dirs.xdg?.find(x => x.exists)?.path ?? (dirs.cloud_remote?.exists ? dirs.cloud_remote.path : undefined) ?? undefined;
}

export class GamesTreeProvider implements vscode.TreeDataProvider<GameNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<GameNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly sub: vscode.Disposable;
  private roots?: Promise<GameNode[]>;
  apps?: AppSummary[];
  private readonly nodes = new Map<number, GameNode>();

  constructor(private readonly conn: ConnectionState) {
    this.sub = conn.onDidChangeTarget(() => this.refresh());
  }

  refresh(): void {
    this.roots = undefined;
    this.apps = undefined;
    this.nodes.clear();
    this.changed.fire(undefined);
  }

  private get client(): DeckyClient | undefined {
    return (this.conn.link === 'connected' && this.conn.authedClient()) || undefined;
  }

  getTreeItem(n: GameNode): vscode.TreeItem {
    return n;
  }

  getParent(n: GameNode): GameNode | undefined {
    return n.parentNode;
  }

  async getChildren(n?: GameNode): Promise<GameNode[]> {
    if (n) return n.load ? n.load() : [];
    const client = this.client;
    const device = this.conn.connectedDevice;
    if (!client || !device) return [];
    this.roots ??= this.loadRoots(client, device);
    return this.roots;
  }

  /** Installed titles, loading them when the view has not yet. */
  async list(): Promise<AppSummary[]> {
    await this.getChildren();
    return this.apps ?? [];
  }

  async nodeFor(appid: number): Promise<GameNode | undefined> {
    await this.getChildren();
    return this.nodes.get(appid);
  }

  private async loadRoots(client: DeckyClient, device: SavedDevice): Promise<GameNode[]> {
    let apps: AppSummary[];
    try {
      apps = sortGames((await client.apps()).apps);
    } catch (e) {
      const n = info(`Could not load games: ${describeError(e)}`, 'warning');
      n.tooltip = 'Click to retry';
      n.command = { command: 'decky-toolkit.refreshGames', title: 'Retry' };
      this.roots = undefined;
      return [n];
    }
    this.apps = apps;
    if (apps.length === 0) return [info('No installed games')];
    return apps.map(app => {
      const node = gameRow(client, device, app);
      this.nodes.set(app.appid, node);
      return node;
    });
  }

  dispose(): void {
    this.sub.dispose();
    this.changed.dispose();
  }
}

function gameRow(client: DeckyClient, device: SavedDevice, app: AppSummary): GameNode {
  const name = gameName(app);
  const n = new GameNode(name, vscode.TreeItemCollapsibleState.Collapsed);
  n.id = `game:${app.appid}`;
  n.app = app;
  n.device = device;
  n.description = runtimeLabel(app) + (app.running ? ' · running' : '');
  n.iconPath = new vscode.ThemeIcon(app.running ? 'play-circle' : 'game', app.running ? new vscode.ThemeColor('charts.green') : undefined);
  n.contextValue = app.running ? 'game.running' : 'game';
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**${name}** · ${app.appid}${app.type === 'shortcut' ? ' · non-Steam shortcut' : ''}\n\n`);
  md.appendMarkdown(`- runtime: ${app.compat_tool_display ?? runtimeLabel(app)}\n`);
  if (app.install_dir) md.appendMarkdown(`- install: \`${app.install_dir}\`\n`);
  if (app.size_on_disk) md.appendMarkdown(`- size: ${formatSize(app.size_on_disk)}\n`);
  md.appendMarkdown(`- last played: ${app.last_played ? `${relativeTime(app.last_played)} (${app.last_played})` : 'never'}\n`);
  n.tooltip = md;
  n.load = () => gameChildren(client, n);
  return n;
}

export async function gameChildren(client: DeckyClient, game: GameNode): Promise<GameNode[]> {
  const app = game.app!;
  const [dirsR, savesR] = await Promise.allSettled([client.appDirs(app.appid), client.appSaves(app.appid)]);
  const dirs = dirsR.status === 'fulfilled' ? dirsR.value : undefined;
  const saves = savesR.status === 'fulfilled' ? savesR.value : undefined;
  const name = gameName(app);
  const out: GameNode[] = [];

  const saveGroup = child(game, new GameNode('Save data', vscode.TreeItemCollapsibleState.Expanded));
  saveGroup.id = `${game.id}/saves`;
  saveGroup.iconPath = new vscode.ThemeIcon('save');
  saveGroup.contextValue = 'gameGroup';
  const locations = saves ? saveLocations(saves).slice(0, MAX_SAVE_LOCATIONS) : [];
  saveGroup.description = saves ? (locations.length ? `${saves.candidates.length} file${saves.candidates.length === 1 ? '' : 's'}` : 'none found') : 'unavailable';
  saveGroup.load = async () => {
    if (savesR.status === 'rejected') return [child(saveGroup, info(`Could not load saves: ${describeError(savesR.reason)}`, 'warning'))];
    if (!locations.length) return [child(saveGroup, info('No save files found', 'info', saves?.notes.join('; ') || undefined))];
    return locations.map((loc, i) => {
      const n = dirNode(client, saveGroup, loc.dir, prettyPath(loc.dir, dirs), `${name} saves`, i === 0);
      const count = loc.files.length;
      n.description = [`${count} save${count === 1 ? '' : 's'}`, relativeTime(loc.newest)].filter(Boolean).join(' · ');
      n.iconPath = new vscode.ThemeIcon(loc.rank === 0 ? 'cloud' : 'folder');
      const md = new vscode.MarkdownString();
      md.appendMarkdown(`\`${loc.dir}\`\n\n`);
      for (const f of loc.files.slice(0, 12)) md.appendMarkdown(`- ${basename(f.path)} · ${formatSize(f.size)} · ${f.found_by}\n`);
      n.tooltip = md;
      n.saveFiles = new Set(loc.files.map(f => basename(f.path)));
      return n;
    });
  };
  out.push(saveGroup);

  if (!dirs) {
    out.push(child(game, info(`Could not load folders: ${describeError(dirsR.status === 'rejected' ? dirsR.reason : undefined)}`, 'warning')));
  } else {
    for (const x of dirs.xdg ?? []) {
      if (!x.exists || !x.path) continue;
      const n = dirNode(client, game, x.path, 'Game data', `${name} data`);
      n.description = prettyPath(x.path, dirs);
      out.push(n);
    }
    if (dirs.install_dir?.exists && dirs.install_dir.path) {
      const n = dirNode(client, game, dirs.install_dir.path, 'Install folder', `${name} install`);
      n.iconPath = new vscode.ThemeIcon('folder-library');
      n.description = prettyPath(dirs.install_dir.path, dirs);
      out.push(n);
    }
    if (dirs.prefix?.exists && dirs.prefix.path) {
      const steamuser = `${dirs.prefix.path}/drive_c/users/steamuser`;
      const g = dirNode(client, game, steamuser, 'Proton prefix', `${name} prefix`);
      g.iconPath = new vscode.ThemeIcon('package');
      g.description = runtimeLabel(app);
      g.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
      const shortcuts: [keyof GameDirs['prefix_user_dirs'], string][] = [
        ['appdata_local', 'AppData/Local'], ['appdata_roaming', 'AppData/Roaming'], ['appdata_locallow', 'AppData/LocalLow'],
        ['documents', 'Documents'], ['saved_games', 'Saved Games'],
      ];
      g.load = async () => {
        const rows = shortcuts.filter(([k]) => dirs.prefix_user_dirs?.[k]?.exists).map(([k, label]) => {
          const d = dirs.prefix_user_dirs[k];
          const n = dirNode(client, g, d.path!, label, `${name} ${label}`);
          if (d.matches?.length) n.description = d.matches.map(basename).join(', ');
          return n;
        });
        const drive = dirNode(client, g, `${dirs.prefix.path}/drive_c`, 'drive_c', `${name} drive_c`);
        drive.iconPath = new vscode.ThemeIcon('server');
        return [...rows, drive];
      };
      out.push(g);
    }
    if (dirs.userdata?.exists && dirs.userdata.path) {
      const n = dirNode(client, game, dirs.userdata.path, 'Steam Cloud (userdata)', `${name} userdata`);
      n.iconPath = new vscode.ThemeIcon('cloud');
      n.description = `userdata/${dirs.account_id}/${app.appid}`;
      out.push(n);
    }
    if (dirs.shader_cache?.exists && dirs.shader_cache.path) {
      const n = dirNode(client, game, dirs.shader_cache.path, 'Shader cache', `${name} shader cache`);
      n.iconPath = new vscode.ThemeIcon('zap');
      out.push(n);
    }
  }
  const log = child(game, new GameNode(isProton(app) ? 'Proton log' : 'Launch log'));
  log.id = `${game.id}/log`;
  log.iconPath = new vscode.ThemeIcon('output');
  log.contextValue = 'gameLog';
  log.tooltip = '~/steam-<appid>.log (written with PROTON_LOG=1) and the lines of Steam\'s logs that mention this title';
  log.command = { command: 'decky-toolkit.gameProtonLog', title: 'Show log', arguments: [game] };
  out.push(log);
  return out;
}

function dirNode(client: DeckyClient, parent: GameNode, path: string, label: string, explorerName: string, expanded = false): GameNode {
  const n = child(parent, new GameNode(label, expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed));
  n.id = `${parent.id}/${path}`;
  n.devicePath = path;
  n.isDir = true;
  n.explorerName = explorerName;
  n.iconPath = vscode.ThemeIcon.Folder ?? new vscode.ThemeIcon('folder');
  n.resourceUri = n.device ? deckyUri(n.device, path) : undefined;
  n.tooltip = path;
  n.contextValue = 'deckyDir';
  n.load = () => listDir(client, n);
  return n;
}

async function listDir(client: DeckyClient, dir: GameNode): Promise<GameNode[]> {
  let entries: FsEntry[];
  let truncated = false;
  try {
    const l = await client.fsList(dir.devicePath!);
    entries = l.entries;
    truncated = l.truncated;
  } catch (e) {
    return [child(dir, info(`Could not list: ${describeError(e)}`, 'warning'))];
  }
  if (!entries.length) return [child(dir, info('Empty folder'))];
  const isDir = (e: FsEntry) => e.type === 'dir';
  const sorted = [...entries].sort((a, b) => Number(isDir(b)) - Number(isDir(a)) || a.path.localeCompare(b.path));
  const base = dir.devicePath!.replace(/\/$/, '');
  const rows = sorted.map(e => {
    const full = `${base}/${e.path}`;
    if (isDir(e)) return dirNode(client, dir, full, e.path, `${gameName(dir.app!)} ${e.path}`);
    return fileNode(dir, full, e);
  });
  if (truncated) rows.push(child(dir, info(`Only the first ${entries.length} entries are shown`, 'warning')));
  return rows;
}

function fileNode(dir: GameNode, path: string, e: FsEntry): GameNode {
  const n = child(dir, new GameNode(e.path));
  n.id = `${dir.id}/${e.path}`;
  n.devicePath = path;
  n.isDir = false;
  const save = dir.saveFiles?.has(e.path);
  n.description = [formatSize(e.size), relativeTime(e.mtime)].filter(Boolean).join(' · ');
  n.contextValue = 'deckyFile';
  if (n.device) {
    n.resourceUri = deckyUri(n.device, path);
    n.command = { command: 'vscode.open', title: 'Open', arguments: [n.resourceUri] };
  }
  n.iconPath = e.sensitive ? new vscode.ThemeIcon('lock') : save ? new vscode.ThemeIcon('save')
    : e.type === 'symlink' ? new vscode.ThemeIcon('file-symlink-file') : vscode.ThemeIcon.File ?? new vscode.ThemeIcon('file');
  n.tooltip = `${path}${e.target ? ` → ${e.target}` : ''}${e.mtime ? `\nmodified ${e.mtime}` : ''}${save ? '\nsave file' : ''}`;
  return n;
}

// ---- commands ----

function appidOf(arg: unknown): number | undefined {
  if (typeof arg === 'number') return arg;
  if (typeof arg === 'string' && /^\d+$/.test(arg)) return Number(arg);
  const app = (arg as GameNode | undefined)?.app;
  return app?.appid;
}

async function pickGame(tree: GamesTreeProvider, placeHolder: string): Promise<AppSummary | undefined> {
  const apps = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Loading games' }, () => tree.list());
  if (!apps.length) {
    void vscode.window.showInformationMessage('Decky Toolkit: no installed games found on the device.');
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(buildGamePicks(apps), { placeHolder, matchOnDescription: true, matchOnDetail: true });
  return picked?.app;
}

async function gameFor(tree: GamesTreeProvider, arg: unknown, placeHolder: string): Promise<AppSummary | undefined> {
  const id = appidOf(arg);
  if (id === undefined) return pickGame(tree, placeHolder);
  return (arg as GameNode)?.app ?? (await tree.list()).find(a => a.appid === id) ?? { appid: id, name: null } as AppSummary;
}

export async function findGame(conn: Connection, tree: GamesTreeProvider, view: vscode.TreeView<GameNode>): Promise<void> {
  if (!(await conn.client())) return;
  const app = await pickGame(tree, 'Find game (fuzzy match on the name)');
  if (!app) return;
  const node = await tree.nodeFor(app.appid);
  if (node) await view.reveal(node, { select: true, focus: true, expand: true });
}

/** Adds the device folder as a workspace folder (or reveals it when already there). */
export async function openInExplorer(device: SavedDevice, path: string, name: string): Promise<void> {
  const uri = deckyUri(device, path);
  const folders = vscode.workspace.workspaceFolders ?? [];
  const existing = folders.find(f => f.uri.toString() === uri.toString());
  if (!existing) {
    const added = vscode.workspace.updateWorkspaceFolders(folders.length, 0, { uri, name: `${name} (${deviceAuthority(device)})` });
    if (!added) throw new Error(`VS Code refused to add ${uri.toString()} as a workspace folder`);
  }
  await vscode.commands.executeCommand('workbench.view.explorer');
  if (existing) await vscode.commands.executeCommand('revealInExplorer', uri);
}

export async function openNodeInExplorer(conn: Connection, arg: unknown): Promise<void> {
  const n = arg as GameNode | undefined;
  if (!n?.devicePath || !n.device) return openDeckyPath(conn);
  const path = n.isDir ? n.devicePath : dirname(n.devicePath);
  await openInExplorer(n.device, path, n.isDir ? n.explorerName ?? basename(path) : `${gameName(n.app!)} ${basename(path)}`);
}

export async function copyDeckyPath(arg: unknown): Promise<void> {
  const n = arg as GameNode | undefined;
  const path = n?.devicePath ?? n?.app?.install_dir;
  if (!path) return;
  await vscode.env.clipboard.writeText(path);
  vscode.window.setStatusBarMessage(`Copied ${path}`, 3000);
}

export async function openGameSaves(conn: Connection, tree: GamesTreeProvider, arg?: unknown): Promise<void> {
  const client = await conn.client();
  const device = conn.connectedDevice;
  if (!client || !device) return;
  const app = await gameFor(tree, arg, 'Open the save data of which game?');
  if (!app) return;
  const name = gameName(app);
  const [saves, dirs] = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Finding save data of ${name}` },
    () => Promise.all([client.appSaves(app.appid).catch(() => undefined), client.appDirs(app.appid).catch(() => undefined)]));
  const folder = bestSaveFolder(saves, dirs);
  if (!folder) {
    void vscode.window.showWarningMessage(`Decky Toolkit: no save data found for ${name}${saves?.notes.length ? ` (${saves.notes.join('; ')})` : ''}.`);
    return;
  }
  await openInExplorer(device, folder, `${name} saves`);
}

export async function openDeckyPath(conn: Connection): Promise<void> {
  const client = await conn.client();
  const device = conn.connectedDevice;
  if (!client || !device) return;
  const input = await vscode.window.showInputBox({
    title: `Open a path on ${device.name}`,
    prompt: 'Absolute path on the device (or ~/… for the desktop user\'s home). Folders open in the Explorer, files in the editor.',
    placeHolder: '~/.local/share/Steam/steamapps/compatdata',
    validateInput: v => (/^(\/|~(\/|$))/.test(v.trim()) ? undefined : 'Start with / or ~/'),
  });
  if (!input) return;
  let path = input.trim().replace(/(.)\/+$/, '$1');
  if (path === '~' || path.startsWith('~/')) {
    // The server expands ~; its answer carries the absolute path.
    const home = (await client.fsList('~', '\0')).path;
    path = home + path.slice(1);
  }
  let isDir = path === '/';
  if (!isDir) {
    const entry = (await client.fsList(dirname(path), globEscape(basename(path)))).entries.find(e => e.path === basename(path));
    if (!entry) throw new Error(`${input} does not exist on ${device.name}`);
    isDir = entry.type === 'dir' || (entry.type === 'symlink' && await client.fsList(path, '\0').then(() => true, () => false));
  }
  if (isDir) await openInExplorer(device, path, basename(path) || path);
  else await vscode.commands.executeCommand('vscode.open', deckyUri(device, path));
}

export async function gameLaunch(conn: Connection, tree: GamesTreeProvider, arg?: unknown): Promise<void> {
  const client = await conn.client();
  if (!client) return;
  const app = await gameFor(tree, arg, 'Launch which game?');
  if (!app) return;
  const res = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Launching ${gameName(app)}` },
    () => client.launchApp(app.appid));
  if (res.running) void vscode.window.showInformationMessage(`Decky Toolkit: ${res.name ?? gameName(app)} is running${res.launched ? '' : ' (it already was)'}.`);
  else void vscode.window.showWarningMessage(`Decky Toolkit: ${res.name ?? gameName(app)} did not start${res.note ? `: ${res.note}` : ''}.`);
  tree.refresh();
}

export async function gameTerminate(conn: Connection, tree: GamesTreeProvider, arg?: unknown): Promise<void> {
  const client = await conn.client();
  if (!client) return;
  const app = await gameFor(tree, arg, 'Terminate which game?');
  if (!app) return;
  const name = gameName(app);
  const ok = await vscode.window.showWarningMessage(`Terminate ${name} on ${conn.label}?`,
    { modal: true, detail: 'The game is closed without saving; unsaved progress is lost.' }, 'Terminate');
  if (ok !== 'Terminate') return;
  const res = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Terminating ${name}` },
    () => client.terminateApp(app.appid));
  if (res.running) void vscode.window.showWarningMessage(`Decky Toolkit: ${name} is still running.`);
  else void vscode.window.showInformationMessage(`Decky Toolkit: ${name} ${res.terminated ? 'terminated' : 'was not running'}.`);
  tree.refresh();
}

export function protonLogText(app: Pick<AppSummary, 'appid' | 'name'>, device: string, log: Pick<ProtonLog, 'proton_log' | 'steam_logs'>): string {
  const out = [`# ${gameName(app)} (${app.appid}) on ${device}`, ''];
  const p = log.proton_log;
  if (p.lines) out.push(`## ${p.path} (modified ${p.mtime})`, ...p.lines, '');
  else out.push(`## ${p.path}: not found`, p.hint ?? '', '');
  if (!log.steam_logs.length) out.push('## Steam logs: no lines mention this appid');
  for (const s of log.steam_logs) out.push(`## ${s.file} (modified ${s.mtime})`, ...s.lines, '');
  return out.join('\n');
}

export async function gameProtonLog(conn: Connection, tree: GamesTreeProvider, arg?: unknown): Promise<void> {
  const client = await conn.client();
  if (!client) return;
  const app = await gameFor(tree, arg, 'Show the Proton log of which game?');
  if (!app) return;
  const log = await client.protonLog(app.appid);
  const doc = await vscode.workspace.openTextDocument({ content: protonLogText(app, conn.label, log), language: 'log' });
  await vscode.window.showTextDocument(doc, { preview: true });
}
