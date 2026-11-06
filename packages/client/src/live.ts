// Live sync: push the files a change touched into the installed plugin and reload it in place, instead of a full
// deploy. A bundle change re-imports only the frontend (the backend keeps running); a Python change restarts the
// backend; a manifest change falls back to a full deploy. The device restores the panel, route, tab and focus.
import { spawn, type ChildProcess } from 'child_process';
import { createHash } from 'crypto';
import { promises as fs, readFileSync, watch, type FSWatcher } from 'fs';
import * as path from 'path';
import type { LiveReloadMode, LiveReloadResult } from './api';
import type { DeckyClient } from './client';
import type { WorkspacePlugin } from './deploy';
import { SourceMap, mapStack } from './sourcemap';

export type ChangeKind = 'manifest' | 'backend' | 'frontend' | 'sourcemap' | 'ignore';

const SYNCED_DIRS = ['dist', 'py_modules', 'assets', 'defaults'];

/** What a change to `rel` (relative to the plugin root, `/`-separated) needs. */
export function classify(rel: string): ChangeKind {
  const parts = rel.split('/');
  if (parts.some(p => p.startsWith('.') || p === '__pycache__' || p === 'node_modules')) return 'ignore';
  if (rel === 'plugin.json' || rel === 'package.json') return 'manifest';
  if (rel === 'main.py') return 'backend';
  if (!SYNCED_DIRS.includes(parts[0]) || parts.length < 2) return 'ignore';
  if (parts[0] === 'py_modules') return 'backend';
  return rel.endsWith('.map') ? 'sourcemap' : 'frontend';
}

async function hashFile(file: string): Promise<string | undefined> {
  try {
    return createHash('sha1').update(await fs.readFile(file)).digest('hex');
  } catch {
    return undefined;
  }
}

async function listFiles(root: string, dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(path.join(root, dir), { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...await listFiles(root, rel));
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

export interface LiveOptions {
  /** One line per call, without a trailing newline. */
  log: (line: string) => void;
  /** Applies a change live sync cannot (plugin.json, package.json). */
  fullDeploy: () => Promise<void>;
  /** Gather changes for this long before syncing; a build writes several files. */
  debounceMs?: number;
  onSynced?: (s: LiveSyncStep) => void;
}

export interface LiveSyncStep {
  files: string[];
  mode?: LiveReloadMode;
  pushMs: number;
  reloadMs?: number;
  /** From the first change notice to the reload's answer. */
  totalMs: number;
  result?: LiveReloadResult;
  error?: string;
}

export class LiveSync {
  private readonly hashes = new Map<string, string>();
  private readonly pending = new Set<string>();
  private timer?: NodeJS.Timeout;
  private busy = false;
  private firstChangeAt = 0;
  private disposed = false;

  constructor(private readonly client: DeckyClient, readonly plugin: WorkspacePlugin, private readonly o: LiveOptions) {}

  /** Record what is on disk now as what the device has (call right after a full deploy). */
  async seed(): Promise<void> {
    const files = ['main.py', 'plugin.json', 'package.json'];
    for (const d of SYNCED_DIRS) files.push(...await listFiles(this.plugin.root, d));
    await Promise.all(files.map(async f => {
      const h = await hashFile(path.join(this.plugin.root, f));
      if (h) this.hashes.set(f, h);
    }));
  }

  /** A file under the plugin root changed; `rel` may use either separator. */
  notify(rel: string): void {
    rel = rel.split(path.sep).join('/');
    if (this.disposed || classify(rel) === 'ignore') return;
    this.pending.add(rel);
    this.firstChangeAt ||= Date.now();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.o.debounceMs ?? 40);
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
  }

  private async changedFiles(): Promise<string[]> {
    const out: string[] = [];
    for (const rel of this.pending) {
      const h = await hashFile(path.join(this.plugin.root, rel));
      if (h && h !== this.hashes.get(rel)) {
        this.hashes.set(rel, h);
        out.push(rel);
      }
    }
    this.pending.clear();
    return out;
  }

  private async flush(): Promise<void> {
    // The running flush picks up whatever arrived meanwhile when it finishes.
    if (this.busy || this.disposed) return;
    this.busy = true;
    try {
      const files = await this.changedFiles();
      const since = this.firstChangeAt;
      this.firstChangeAt = 0;
      if (files.length) await this.sync(files, since);
    } finally {
      this.busy = false;
      if (this.pending.size && !this.disposed) void this.flush();
    }
  }

  private async sync(files: string[], since: number): Promise<void> {
    const kinds = new Set(files.map(classify));
    if (kinds.has('manifest')) {
      this.o.log(`${files.filter(f => classify(f) === 'manifest').join(', ')} changed: full deploy`);
      await this.o.fullDeploy();
      await this.seed();
      return;
    }
    const mode: LiveReloadMode | undefined = kinds.has('backend') ? 'backend' : kinds.has('frontend') ? 'frontend' : undefined;
    const now = files.filter(f => classify(f) !== 'sourcemap');
    const maps = files.filter(f => classify(f) === 'sourcemap');
    const dir = this.plugin.dir;
    const step: LiveSyncStep = { files: now, mode, pushMs: 0, totalMs: 0 };
    try {
      const t0 = Date.now();
      await Promise.all(now.map(async f => this.client.putPluginFile(dir, f, await fs.readFile(path.join(this.plugin.root, f)))));
      step.pushMs = Date.now() - t0;
      // A newer build landed during the push: its own sync follows, so skip this reload.
      if (mode && !(await this.isStale(now))) {
        const r0 = Date.now();
        step.result = await this.client.reloadPlugin(dir, mode);
        step.reloadMs = Date.now() - r0;
        if (step.result.scheduled) await this.client.waitForRestart(30000);
      }
      step.totalMs = Date.now() - since;
      this.report(step);
      if (maps.length) {
        await Promise.all(maps.map(async f => this.client.putPluginFile(dir, f, await fs.readFile(path.join(this.plugin.root, f)))));
      }
    } catch (e) {
      step.error = e instanceof Error ? e.message : String(e);
      step.totalMs = Date.now() - since;
      this.o.log(`Live sync of ${now.join(', ') || maps.join(', ')} failed: ${step.error}`);
      this.o.onSynced?.(step);
    }
  }

  private async isStale(pushed: string[]): Promise<boolean> {
    for (const f of pushed) {
      if (await hashFile(path.join(this.plugin.root, f)) !== this.hashes.get(f)) return true;
    }
    return false;
  }

  private report(step: LiveSyncStep): void {
    const r = step.result;
    const files = step.files.join(', ');
    if (!r) {
      this.o.log(`Synced ${files} (${step.pushMs} ms); skipped the reload, a newer build is on its way`);
    } else if (r.scheduled) {
      this.o.log(`Synced ${files} and restarted ${r.name}'s backend (${step.totalMs} ms; this plugin serves the connection)`);
    } else {
      const restored = r.restored?.length ? `; restored ${r.restored.join(', ')}` : '';
      this.o.log(`${step.mode} reload of ${r.name}: ${files}, push ${step.pushMs} ms, reload ${step.reloadMs} ms ` +
        `(in Steam ${r.load_ms} ms), ${step.totalMs} ms after the files changed${restored}`);
      if (r.reloaded === false) this.o.log(`${r.name} did not come back after the reload; check the plugin log`);
    }
    for (const e of r?.errors ?? []) this.o.log(`  ${this.mapErrors(e)}`);
    this.o.onSynced?.(step);
  }

  private mapErrors(text: string): string {
    try {
      // Read on demand: the map changes with every build and is only needed when something failed.
      const raw = readFileSync(path.join(this.plugin.root, 'dist', 'index.js.map'), 'utf8');
      return mapStack(text, new SourceMap(JSON.parse(raw)));
    } catch {
      return text;
    }
  }
}

/** Calls `onChange` with root-relative paths of files that may need syncing (`fs.watch`, for the CLI). */
export function watchPlugin(root: string, onChange: (rel: string) => void): { close(): void } {
  const watchers: FSWatcher[] = [];
  const add = (target: string, prefix: string, recursive: boolean) => {
    try {
      watchers.push(watch(path.join(root, target), { recursive }, (_e, f) => {
        if (f) onChange(prefix ? `${prefix}/${f}` : f);
      }));
    } catch {
      // Missing (no backend, no assets): nothing to watch.
    }
  };
  for (const d of SYNCED_DIRS) add(d, d, true);
  // The root itself for main.py and the manifests; editors replace files, which watching the file alone misses.
  add('.', '', false);
  return { close: () => watchers.forEach(w => w.close()) };
}

/** Runs the plugin's own `watch` script (vite, rollup, ...) with its local binaries on PATH, if it has one. */
export async function startWatchBuild(root: string, onLine: (line: string) => void): Promise<ChildProcess | undefined> {
  let script: unknown;
  try {
    script = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).scripts?.watch;
  } catch {
    return undefined;
  }
  if (typeof script !== 'string' || !script) return undefined;
  const child = spawn(script, {
    cwd: root,
    shell: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PATH: `${path.join(root, 'node_modules', '.bin')}${path.delimiter}${process.env.PATH ?? ''}`, FORCE_COLOR: '0' },
  });
  const forward = (d: Buffer) => {
    for (const line of d.toString().replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/)) if (line.trim()) onLine(line);
  };
  child.stdout?.on('data', forward);
  child.stderr?.on('data', forward);
  return child;
}

/** Ends a `startWatchBuild` child and everything its shell started. */
export function stopWatchBuild(child: ChildProcess): void {
  try {
    if (child.pid && process.platform !== 'win32') process.kill(-child.pid);
    else child.kill();
  } catch {
    // Already gone.
  }
}
