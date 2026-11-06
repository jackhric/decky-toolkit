// Workspace plugin detection and build decisions around the shared deploy pipeline. No `vscode` import, so
// scripts/deploy-check.mjs can run it against a device from a plain Node process.
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import type { DeckyClient } from '@decky-toolkit/client/client';
import { DeployOptions, DeployStep, WorkspacePlugin, deployPlugin, exists, readJson } from '@decky-toolkit/client/deploy';

export type BuildMode = 'auto' | 'always' | 'never';

const SCAN_SKIP = new Set(['node_modules', 'dist', 'out', 'build', 'py_modules', 'bin', 'defaults', 'assets', 'static']);

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

const FRONTEND_INPUTS = ['src', 'tsconfig.json', 'rollup.config.js', 'rollup.config.mjs', 'rollup.config.ts', 'vite.config.js', 'vite.config.mjs', 'vite.config.ts'];

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

/** `log` gets whole lines: the command, then the build's output. */
export async function runBuild(root: string, log: (line: string) => void, signal?: AbortSignal): Promise<void> {
  const pm = await packageManager(root);
  const cmd = `${pm} run build`;
  log(`$ ${cmd}   (in ${root})`);
  await new Promise<void>((resolve, reject) => {
    // shell: true so pnpm.cmd resolves on Windows and the user's PATH (nvm, corepack) applies.
    const child = spawn(cmd, { cwd: root, shell: true, env: process.env });
    let tail = '', partial = '';
    const onData = (d: Buffer) => {
      const s = d.toString();
      tail = (tail + s).slice(-2000);
      const lines = (partial + s).split('\n');
      partial = lines.pop()!;
      for (const l of lines) log(l.replace(/\r$/, ''));
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const abort = () => child.kill();
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', e => { signal?.removeEventListener('abort', abort); reject(e); });
    child.on('close', code => {
      signal?.removeEventListener('abort', abort);
      if (partial) log(partial);
      if (signal?.aborted) return reject(signal.reason);
      if (code === 0) return resolve();
      // The last error-looking line is usually the useful one (rollup/tsc print it near the end).
      const lines = tail.split('\n').map(l => l.replace(/\x1b\[[0-9;]*m/g, '').trim()).filter(Boolean);
      const hint = [...lines].reverse().find(l => /error/i.test(l) && !/ELIFECYCLE|ERR_PNPM_RECURSIVE/.test(l)) ?? lines.at(-1);
      reject(new BuildError(`${cmd} exited with code ${code}${hint ? `: ${hint}` : ''}`));
    });
  });
}

export type BuildStep = DeployStep & { build: { ran: boolean; reason: string; ms: number } };

export interface BuildAndDeployOptions extends Omit<DeployOptions, 'restart'> {
  /** `fast` takes `chooseRestart`'s pick, which never restarts the loader for an installed plugin. */
  restart: 'fast' | 'loader';
  build: BuildMode;
}

export async function buildAndDeploy(client: DeckyClient, p: WorkspacePlugin, o: BuildAndDeployOptions): Promise<BuildStep> {
  const t0 = Date.now();
  const decision = await buildDecision(p.root, o.build);
  let build: BuildStep['build'] = { ran: false, reason: decision.reason, ms: 0 };
  if (decision.build) {
    o.onPhase?.('building');
    const b0 = Date.now();
    await runBuild(p.root, o.log, o.signal);
    build = { ran: true, reason: decision.reason, ms: Date.now() - b0 };
  } else {
    o.log(`Build skipped: ${decision.reason}`);
  }
  const step = await deployPlugin(client, p, { ...o, restart: o.restart === 'loader' ? 'loader' : undefined });
  return { ...step, build, totalMs: Date.now() - t0 };
}
