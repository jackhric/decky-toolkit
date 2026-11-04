// Workspace plugin detection, build decisions and the deploy pipeline. No `vscode` import, so
// scripts/deploy-check.mjs can run it against a device from a plain Node process.
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import type { InstallResult, RestartMode } from './api';
import { DeckyClient, isMissingRoute, sleep } from './client';
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

export type BuildMode = 'auto' | 'always' | 'never';

const SCAN_SKIP = new Set(['node_modules', 'dist', 'out', 'build', 'py_modules', 'bin', 'defaults', 'assets', 'static']);

async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function exists(p: string): Promise<boolean> {
  return fs.stat(p).then(() => true, () => false);
}

export async function readWorkspacePlugin(root: string, dirOverride = ''): Promise<WorkspacePlugin | undefined> {
  const meta = await readJson(path.join(root, 'plugin.json'));
  if (!meta) return undefined;
  const pkg = await readJson(path.join(root, 'package.json'));
  const flags = Array.isArray(meta.flags) ? meta.flags.filter((f): f is string => typeof f === 'string') : [];
  return {
    root,
    name: typeof meta.name === 'string' && meta.name ? meta.name : path.basename(root),
    author: typeof meta.author === 'string' ? meta.author : undefined,
    flags,
    apiVersion: typeof meta.api_version === 'number' ? meta.api_version : undefined,
    version: typeof pkg?.version === 'string' ? pkg.version : undefined,
    dir: dirOverride.trim() || path.basename(root),
    hasBackend: await exists(path.join(root, 'main.py')),
    hasDebugFlag: flags.includes('debug'),
  };
}

/** Folders at most `maxDepth` levels below `base` (inclusive of `base`) that contain a plugin.json. */
export async function findPluginRoots(base: string, maxDepth = 2): Promise<string[]> {
  const found: string[] = [];
  const visit = async (dir: string, depth: number) => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some(e => e.isFile() && e.name === 'plugin.json')) {
      found.push(dir);
      // A plugin's own subfolders (py_modules, backend, …) never hold another plugin.
      return;
    }
    if (depth >= maxDepth) return;
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isDirectory() && !e.name.startsWith('.') && !SCAN_SKIP.has(e.name)) await visit(path.join(dir, e.name), depth + 1);
    }
  };
  await visit(base, 0);
  return found;
}

async function newestMtime(p: string): Promise<number> {
  let st;
  try {
    st = await fs.stat(p);
  } catch {
    return 0;
  }
  if (!st.isDirectory()) return st.mtimeMs;
  let newest = 0;
  for (const child of await fs.readdir(p)) {
    if (child === 'node_modules' || child.startsWith('.')) continue;
    newest = Math.max(newest, await newestMtime(path.join(p, child)));
  }
  return newest;
}

const FRONTEND_INPUTS = ['src', 'tsconfig.json', 'rollup.config.js', 'rollup.config.mjs', 'rollup.config.ts'];

/** Python files ship as they are; only the frontend (`src/` → `dist/index.js`) ever needs a build. */
export async function buildDecision(root: string, mode: BuildMode): Promise<{ build: boolean; reason: string }> {
  if (mode === 'never') return { build: false, reason: 'build mode "never"' };
  const pkg = await readJson(path.join(root, 'package.json'));
  const hasScript = typeof (pkg?.scripts as Record<string, unknown> | undefined)?.build === 'string';
  if (!hasScript) return { build: false, reason: 'package.json has no "build" script' };
  if (mode === 'always') return { build: true, reason: 'build mode "always"' };
  const dist = await fs.stat(path.join(root, 'dist', 'index.js')).catch(() => undefined);
  if (!dist) return { build: true, reason: 'dist/index.js is missing' };
  let newest = 0, newestName = '';
  for (const name of FRONTEND_INPUTS) {
    const m = await newestMtime(path.join(root, name));
    if (m > newest) [newest, newestName] = [m, name];
  }
  if (newest > dist.mtimeMs) return { build: true, reason: `${newestName} is newer than dist/index.js` };
  return { build: false, reason: 'dist/index.js is up to date' };
}

export async function packageManager(root: string): Promise<'pnpm' | 'npm' | 'yarn'> {
  if (await exists(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (await exists(path.join(root, 'package-lock.json'))) return 'npm';
  if (await exists(path.join(root, 'yarn.lock'))) return 'yarn';
  return 'pnpm';
}

export class BuildError extends Error {}

export async function runBuild(root: string, log: (s: string) => void, signal?: AbortSignal): Promise<void> {
  const pm = await packageManager(root);
  const cmd = `${pm} run build`;
  log(`$ ${cmd}   (in ${root})\n`);
  await new Promise<void>((resolve, reject) => {
    // shell: true so pnpm.cmd resolves on Windows and the user's PATH (nvm, corepack) applies.
    const child = spawn(cmd, { cwd: root, shell: true, env: process.env });
    let tail = '';
    const onData = (d: Buffer) => {
      const s = d.toString();
      tail = (tail + s).slice(-2000);
      log(s);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const abort = () => child.kill();
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', e => { signal?.removeEventListener('abort', abort); reject(e); });
    child.on('close', code => {
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) return reject(signal.reason);
      if (code === 0) return resolve();
      // The last error-looking line is usually the useful one (rollup/tsc print it near the end).
      const lines = tail.split('\n').map(l => l.replace(/\x1b\[[0-9;]*m/g, '').trim()).filter(Boolean);
      const hint = [...lines].reverse().find(l => /error/i.test(l) && !/ELIFECYCLE|ERR_PNPM_RECURSIVE/.test(l)) ?? lines.at(-1);
      reject(new BuildError(`${cmd} exited with code ${code}${hint ? `: ${hint}` : ''}`));
    });
  });
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

async function isInstalled(client: DeckyClient, p: WorkspacePlugin): Promise<boolean> {
  const listed = await client.listPlugins();
  return listed.some(x => x.dir === p.dir && x.name === p.name);
}

export interface ReloadMarkers {
  journal: string[];
  pluginLog?: string[];
}

export async function reloadMarkers(client: DeckyClient, p: WorkspacePlugin): Promise<ReloadMarkers> {
  const [journal, pluginLog] = await Promise.all([
    client.logTail({ source: 'loader', tail: 5 }).then(r => r.lines, () => []),
    p.hasBackend ? client.logTail({ source: 'plugin', plugin: p.dir, tail: 5 }).then(r => r.lines, () => []) : Promise.resolve(undefined),
  ]);
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

/**
 * The loader logs `Loaded <name> (v<version>)` to the journal when it (re-)imports a plugin, right
 * before it tells the frontend to import the bundle again; Decky also starts a new plugin log file
 * for every backend start.
 */
export async function confirmReload(
  client: DeckyClient, p: WorkspacePlugin, before: ReloadMarkers, o: ConfirmOptions = {},
): Promise<ReloadConfirmation> {
  const timeoutMs = o.timeoutMs ?? 10000;
  const settleMs = o.settleMs ?? 0;
  const loaded = new RegExp(`\\[loader\\]\\[INFO\\]: Loaded ${escapeRe(p.name)}( \\(|$)`);
  const start = Date.now();
  let loads = 0, lastLoadAt = 0, logLine: string | undefined, version: string | null | undefined, nudged = false;
  while (Date.now() - start < timeoutMs) {
    const [journal, log, listed] = await Promise.all([
      client.logTail({ source: 'loader', tail: 200 }).then(r => r.lines, () => undefined),
      !before.pluginLog ? undefined : client.logTail({ source: 'plugin', plugin: p.dir, tail: 5 }).then(r => r.lines, () => undefined),
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
      await client.reloadPlugin(p.dir);
    }
    await sleep(250, o.signal);
  }
  if (loads) return { confirmed: true, loads, nudged, detail: `loader imported ${p.name} ${loads} times and was still reloading after ${timeoutMs / 1000} s` };
  return { confirmed: false, loads, nudged, detail: `no "Loaded ${p.name}" in the loader journal within ${timeoutMs / 1000} s` };
}

export interface DeployStep {
  build: { ran: boolean; reason: string; ms: number };
  stageMs: number;
  zipBytes: number;
  files: string[];
  uploadMs: number;
  installed: InstallResult['installed'];
  restarted: RestartMode;
  /** How the new code got loaded: an explicit reload, the loader's file watcher, or a loader restart. */
  via: 'reload' | 'watcher' | 'loader';
  confirm?: ReloadConfirmation & { ms: number };
  totalMs: number;
}

export type DeployPhase = 'building' | 'packaging' | 'uploading' | 'reloading' | 'restarting';

export interface DeployOptions {
  /**
   * `fast` loads the new files without restarting the loader: a new or debug-flagged plugin is
   * picked up by the loader's own file watcher (an explicit reload as well would restart a debug
   * plugin once more, ~2 s later, killing calls in flight); any other plugin gets `restart=plugin`.
   */
  restart: 'fast' | 'loader';
  build: BuildMode;
  log: (s: string) => void;
  signal?: AbortSignal;
  confirmTimeoutMs?: number;
  onPhase?: (phase: DeployPhase) => void;
}

export async function deployPlugin(client: DeckyClient, p: WorkspacePlugin, o: DeployOptions): Promise<DeployStep> {
  const t0 = Date.now();
  const decision = await buildDecision(p.root, o.build);
  let build: DeployStep['build'] = { ran: false, reason: decision.reason, ms: 0 };
  if (decision.build) {
    o.onPhase?.('building');
    const b0 = Date.now();
    await runBuild(p.root, o.log, o.signal);
    build = { ran: true, reason: decision.reason, ms: Date.now() - b0 };
  } else {
    o.log(`Build skipped: ${decision.reason}\n`);
  }

  o.onPhase?.('packaging');
  const s0 = Date.now();
  const { zip, files } = await stagePlugin(p.root, p.dir);
  const stageMs = Date.now() - s0;
  o.log(`Staged ${files.join(', ')} → ${(zip.length / 1024).toFixed(0)} KiB zip in ${stageMs} ms\n`);

  let restart: RestartMode = 'loader';
  if (o.restart === 'fast') {
    // loader/reload_plugin only knows plugins the loader has imported, and the watcher does not
    // import a new plugin dir until the loader next stops (seen 2026-11-04), so a first install restarts.
    if (await isInstalled(client, p)) restart = p.hasDebugFlag ? 'none' : 'plugin';
    else o.log(`${p.dir} is not installed on the device yet; this first install restarts the loader\n`);
  }
  const markers = restart !== 'loader' ? await reloadMarkers(client, p) : undefined;
  o.onPhase?.('uploading');
  const u0 = Date.now();
  let result: InstallResult;
  try {
    result = await client.installPlugin(zip, `${p.dir}.zip`, restart);
  } catch (e) {
    if (isMissingRoute(e)) {
      throw new Error('the Decky Toolkit plugin on the device has no POST /plugins/install yet. ' +
        'Update it to a version with install support (deploy it once with scripts/deploy.sh).');
    }
    throw e;
  }
  const uploadMs = Date.now() - u0;
  o.log(`Installed ${result.installed.name} ${result.installed.version ?? ''} in ${result.installed.dir} (${uploadMs} ms); restart: ${result.restarted}\n`);

  let confirm: DeployStep['confirm'];
  const via: DeployStep['via'] = result.restarted === 'plugin' ? 'reload' : result.restarted === 'none' ? 'watcher' : 'loader';
  if (markers) {
    o.onPhase?.('reloading');
    const c0 = Date.now();
    if (via === 'watcher') o.log('debug flag set: waiting for the loader\'s file watcher to reload it\n');
    const c = await confirmReload(client, p, markers, {
      timeoutMs: o.confirmTimeoutMs ?? 10000,
      nudgeAfterMs: via === 'watcher' ? 4000 : undefined,
      settleMs: via === 'watcher' ? 1500 : 0,
      signal: o.signal,
    });
    confirm = { ...c, ms: Date.now() - c0 };
    if (c.nudged) o.log('The watcher had not reloaded it after 4 s; asked Decky to reload it\n');
    o.log(`${c.confirmed ? 'Reload confirmed' : 'Reload not confirmed'}: ${c.detail} (${confirm.ms} ms)\n`);
  }
  if (result.restarted === 'loader') {
    o.onPhase?.('restarting');
    const health = await client.waitForRestart(90000, o.signal);
    o.log(`Device back: ${health.name} ${health.version}\n`);
  }
  return {
    build, stageMs, zipBytes: zip.length, files, uploadMs, installed: result.installed, restarted: result.restarted, via, confirm,
    totalMs: Date.now() - t0,
  };
}
