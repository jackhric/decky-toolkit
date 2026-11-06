// The plugin deploy pipeline shared by the extension and the CLI: read a plugin folder, stage it, install it and
// confirm the device loaded the new code. Building the plugin is left to the caller.
import { promises as fs } from 'fs';
import * as path from 'path';
import type { Health, InstallResult, RestartMode } from './api';
import { DeckyClient, outdatedDevice, sleep } from './client';
import { stagePlugin } from './stage';

export interface WorkspacePlugin {
  /** Absolute path of the folder holding plugin.json. */
  root: string;
  name: string;
  author?: string;
  flags: string[];
  apiVersion?: number;
  /** From package.json; what `/plugins` reports after install. */
  version?: string;
  /** Directory under ~/homebrew/plugins the deploy installs to. */
  dir: string;
  hasBackend: boolean;
  hasDebugFlag: boolean;
}

export async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function exists(p: string): Promise<boolean> {
  return fs.stat(p).then(() => true, () => false);
}

export async function readWorkspacePlugin(root: string, dirOverride = ''): Promise<WorkspacePlugin | undefined> {
  const [meta, pkg, hasBackend] = await Promise.all([
    readJson(path.join(root, 'plugin.json')), readJson(path.join(root, 'package.json')), exists(path.join(root, 'main.py')),
  ]);
  if (!meta) return undefined;
  const flags = Array.isArray(meta.flags) ? meta.flags.filter((f): f is string => typeof f === 'string') : [];
  return {
    root,
    name: typeof meta.name === 'string' && meta.name ? meta.name : path.basename(root),
    author: typeof meta.author === 'string' ? meta.author : undefined,
    flags,
    apiVersion: typeof meta.api_version === 'number' ? meta.api_version : undefined,
    version: typeof pkg?.version === 'string' ? pkg.version : undefined,
    dir: dirOverride.trim() || path.basename(root),
    hasBackend,
    hasDebugFlag: flags.includes('debug'),
  };
}

/**
 * `requested` wins. Otherwise: a new plugin restarts the loader (loader/reload_plugin only knows plugins the
 * loader imported, and the file watcher never imports a new dir); a debug-flagged one gets `none` and is left to
 * the loader's file watcher, since an explicit reload as well restarts it once more ~2 s later and kills calls in
 * flight; anything else gets `plugin`. The watcher does not always pick a swap up (a `restart=none` install of this
 * repo's plugin went unnoticed on 2026-11-05), so `deployPlugin` asks for a reload when it stays quiet for 4 s.
 */
export function chooseRestart(installed: boolean, hasDebugFlag: boolean, requested?: RestartMode): RestartMode {
  if (requested) return requested;
  if (!installed) return 'loader';
  return hasDebugFlag ? 'none' : 'plugin';
}

/** Lines of `after` that follow the last line of `before`; all of `after` if that line is gone. */
export function newLines(before: string[], after: string[]): string[] {
  const marker = before.at(-1);
  if (marker === undefined) return after;
  const i = after.lastIndexOf(marker);
  return i < 0 ? after : after.slice(i + 1);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface ReloadMarkers {
  journal: string[];
  pluginLog?: string[];
}

const journalTail = (client: DeckyClient) => client.logTail({ source: 'loader', tail: 5 }).catch(() => [] as string[]);
const pluginLogTail = (client: DeckyClient, p: WorkspacePlugin) =>
  p.hasBackend ? client.logTail({ source: 'plugin', plugin: p.dir, tail: 5 }).catch(() => [] as string[]) : Promise.resolve(undefined);

export async function reloadMarkers(client: DeckyClient, p: WorkspacePlugin): Promise<ReloadMarkers> {
  const [journal, pluginLog] = await Promise.all([journalTail(client), pluginLogTail(client, p)]);
  return { journal, pluginLog };
}

export interface ReloadConfirmation {
  confirmed: boolean;
  detail: string;
  /** How many `Loaded <name>` lines appeared (a debug-flagged plugin is usually reloaded twice). */
  loads: number;
  /** The watcher had not reloaded the plugin in time, so `POST /plugins/{dir}/reload` was sent. */
  nudged?: boolean;
}

const UNLOAD_LINE = /unload|Unloaded/;

export interface ConfirmOptions {
  timeoutMs?: number;
  /** Ask Decky to reload the plugin if nothing happened by then (the watcher is off for 10 s after the loader starts). */
  nudgeAfterMs?: number;
  /** Wait until no further reload has shown up for this long; the watcher queues one reload per changed file. */
  settleMs?: number;
  signal?: AbortSignal;
}

// The loader SIGKILLs a backend that has not finished `_unload` after 5 s, and a debug-flagged plugin is
// then loaded up to three times (nudge plus the watcher's two); the first "Loaded" line came 10.4 s after
// an install on 2026-11-05, so 10 s was too short.
const CONFIRM_TIMEOUT_MS = 20000;

/**
 * The loader logs `Loaded <name> (v<version>)` to the journal when it (re-)imports a plugin, right
 * before it tells the frontend to import the bundle again; Decky also starts a new plugin log file
 * for every backend start.
 */
export async function confirmReload(
  client: DeckyClient, p: WorkspacePlugin, before: ReloadMarkers, o: ConfirmOptions = {},
): Promise<ReloadConfirmation> {
  const timeoutMs = o.timeoutMs ?? CONFIRM_TIMEOUT_MS;
  const settleMs = o.settleMs ?? 0;
  const loaded = new RegExp(`\\[loader\\]\\[INFO\\]: Loaded ${escapeRe(p.name)}( \\(|$)`);
  const start = Date.now();
  let loads = 0, lastLoadAt = 0, logLine: string | undefined, version: string | null | undefined, nudged = false;
  while (Date.now() - start < timeoutMs) {
    const [journal, log, listed] = await Promise.all([
      client.logTail({ source: 'loader', tail: 200 }).catch(() => undefined),
      !before.pluginLog ? undefined : client.logTail({ source: 'plugin', plugin: p.dir, tail: 5 }).catch(() => undefined),
      version === undefined ? client.listPlugins().then(ps => ps.find(x => x.dir === p.dir), () => undefined) : undefined,
    ]);
    if (listed) version = listed.version ?? null;
    if (journal) {
      const n = newLines(before.journal, journal).filter(l => loaded.test(l)).length;
      if (n > loads) [loads, lastLoadAt] = [n, Date.now()];
    }
    // The old backend appends its unload lines to the old file; anything else is the new backend.
    if (log && before.pluginLog) logLine = newLines(before.pluginLog, log).filter(l => l.trim() && !UNLOAD_LINE.test(l)).at(-1) ?? logLine;
    const quiet = Date.now() - lastLoadAt;
    // A backend that logs nothing at start gets 1 s after the journal line, not the full timeout.
    if (loads && quiet >= settleMs && (logLine || !before.pluginLog || quiet > 1000)) {
      const v = version ? ` v${version}` : '';
      const times = loads > 1 ? ` (${loads} reloads)` : '';
      return { confirmed: true, loads, nudged, detail: `loader imported ${p.name}${v}${times}${logLine ? `; backend: ${logLine.trim()}` : ''}` };
    }
    if (!loads && !nudged && o.nudgeAfterMs !== undefined && Date.now() - start > o.nudgeAfterMs) {
      nudged = true;
      // Deploying Decky Toolkit itself: its server is down while the watcher reloads it, so the log polls above
      // saw nothing and this call cannot connect. That is the reload in progress, not a failed deploy.
      await client.reloadPlugin(p.dir).catch(() => undefined);
    }
    await sleep(250, o.signal);
  }
  if (loads) return { confirmed: true, loads, nudged, detail: `loader imported ${p.name} ${loads} times and was still reloading after ${timeoutMs / 1000} s` };
  return { confirmed: false, loads, nudged, detail: `no "Loaded ${p.name}" in the loader journal within ${timeoutMs / 1000} s` };
}

export interface DeployStep {
  /** The device dir it went to; differs from `p.dir` when `matchInstalledByName` found the plugin elsewhere. */
  dir: string;
  restart: RestartMode;
  stageMs: number;
  zipBytes: number;
  files: string[];
  uploadMs: number;
  installed: InstallResult['installed'];
  restarted: RestartMode;
  /** How the new code got loaded: an explicit reload, the loader's file watcher, or a loader restart. */
  via: 'reload' | 'watcher' | 'loader';
  confirm?: ReloadConfirmation & { ms: number };
  /** What the device answered once it was back from a loader restart. */
  health?: Health;
  totalMs: number;
}

export type DeployPhase = 'building' | 'packaging' | 'uploading' | 'reloading' | 'restarting';

export interface DeployOptions {
  /** Overrides `chooseRestart`'s pick. */
  restart?: RestartMode;
  /** Install into the dir the device already uses for a plugin of this name (so a checkout under another folder name updates it). */
  matchInstalledByName?: boolean;
  /** One line per call, without a trailing newline. */
  log: (line: string) => void;
  signal?: AbortSignal;
  confirmTimeoutMs?: number;
  onPhase?: (phase: DeployPhase) => void;
}

export async function deployPlugin(client: DeckyClient, plugin: WorkspacePlugin, o: DeployOptions): Promise<DeployStep> {
  const t0 = Date.now();
  o.onPhase?.('packaging');
  const outdated = outdatedDevice(await client.health());
  if (outdated) throw new Error(outdated);
  // The journal marker is taken before anything changes on the device; one taken early only means more lines to scan.
  const [listed, journal] = await Promise.all([client.listPlugins(), journalTail(client)]);
  const existing = listed.find(x => x.name === plugin.name && (o.matchInstalledByName || x.dir === plugin.dir));
  const p = existing ? { ...plugin, dir: existing.dir } : plugin;
  const restart = chooseRestart(!!existing, p.hasDebugFlag, o.restart);
  if (!existing) {
    o.log(restart === 'loader'
      ? `${p.dir} is not installed on the device yet; this first install restarts the loader`
      : `${p.dir} is not installed on the device yet; it loads only after the next loader restart`);
  }
  const expectReload = !!existing && (restart === 'plugin' || (restart === 'none' && p.hasDebugFlag));

  const s0 = Date.now();
  const [{ zip, files }, pluginLog] = await Promise.all([stagePlugin(p.root, p.dir), expectReload ? pluginLogTail(client, p) : undefined]);
  const stageMs = Date.now() - s0;
  o.log(`Staged ${files.join(', ')} → ${(zip.length / 1024).toFixed(0)} KiB zip in ${stageMs} ms`);

  o.onPhase?.('uploading');
  const u0 = Date.now();
  const result = await client.installPlugin(zip, `${p.dir}.zip`, restart);
  const uploadMs = Date.now() - u0;
  o.log(`Installed ${result.installed.name} ${result.installed.version ?? ''} in ${result.installed.dir} (${uploadMs} ms); restart: ${result.restarted}`);

  let confirm: DeployStep['confirm'];
  let health: Health | undefined;
  const via: DeployStep['via'] = result.restarted === 'plugin' ? 'reload' : result.restarted === 'none' ? 'watcher' : 'loader';
  if (expectReload && result.restarted !== 'loader') {
    o.onPhase?.('reloading');
    const c0 = Date.now();
    if (via === 'watcher') o.log('debug flag set: waiting for the loader\'s file watcher to reload it');
    const c = await confirmReload(client, p, { journal, pluginLog }, {
      timeoutMs: o.confirmTimeoutMs ?? CONFIRM_TIMEOUT_MS,
      nudgeAfterMs: via === 'watcher' ? 4000 : undefined,
      settleMs: via === 'watcher' ? 1500 : 0,
      signal: o.signal,
    });
    confirm = { ...c, ms: Date.now() - c0 };
    if (c.nudged) o.log('The watcher had not reloaded it after 4 s; asked Decky to reload it');
    o.log(`${c.confirmed ? 'Reload confirmed' : 'Reload not confirmed'}: ${c.detail} (${confirm.ms} ms)`);
  }
  if (result.restarted === 'loader') {
    o.onPhase?.('restarting');
    o.log('Waiting for the loader to restart');
    health = await client.waitForRestart(90000, o.signal);
    o.log(`Device back: ${health.name} ${health.version}`);
  }
  return {
    dir: p.dir, restart, stageMs, zipBytes: zip.length, files, uploadMs, installed: result.installed, restarted: result.restarted, via, confirm, health,
    totalMs: Date.now() - t0,
  };
}
