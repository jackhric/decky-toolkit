// New plugin from SteamDeckHomebrew/decky-plugin-template, shared by the extension and the CLI: download the tarball,
// rename it, apply the variant and build tool, write it, then install and build with pnpm.
// Imports only Node built-ins so `node --test` runs its tests without a bundler.
import { execFileSync, spawn } from 'child_process';
import { promises as fs } from 'fs';
import { userInfo } from 'os';
import * as path from 'path';
import { gunzipSync } from 'zlib';

export const TEMPLATE_REPO = 'SteamDeckHomebrew/decky-plugin-template';
/** The commit every variant was checked against (generate, typecheck, build, load on a device). Bump it on purpose. */
export const PINNED_TEMPLATE = '90d0780e882a17f5714fc6de044c645f22608290';
const TEMPLATE_BRANCH = 'main';
/** Used through npx when pnpm is not on PATH; 9.x reads the template's lockfile (v9) and runs on Node 18+. */
export const FALLBACK_PNPM = 'pnpm@9.15.9';
const VITE_RANGE = '^8.3.5';
const ZOD_RANGE = '^4.2.0';

export const VARIANTS = ['frontend', 'backend', 'mcp-tool'] as const;
export type Variant = typeof VARIANTS[number];
export const BUILD_TOOLS = ['rollup', 'vite'] as const;
export type BuildTool = typeof BUILD_TOOLS[number];
export const TEMPLATE_VERSIONS = ['pinned', 'latest'] as const;
export type TemplateVersion = typeof TEMPLATE_VERSIONS[number];

export const VARIANT_INFO: Record<Variant, { label: string; detail: string }> = {
  frontend: { label: 'Frontend only', detail: 'A Quick Access panel in TypeScript/React' },
  backend: { label: 'Frontend + Python backend', detail: 'Adds main.py with a method the panel calls' },
  'mcp-tool': { label: 'Frontend + MCP tool', detail: 'Registers a tool coding agents can call (decky-toolkit/tools)' },
};
export const BUILD_INFO: Record<BuildTool, { label: string; detail: string }> = {
  rollup: { label: 'Rollup', detail: 'The template\'s own build (@decky/rollup)' },
  vite: { label: 'Vite', detail: 'Faster rebuilds; same dist/index.js' },
};

export function slugify(name: string): string {
  return name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Why `name` cannot be a plugin name, or undefined. */
export function nameProblem(name: string): string | undefined {
  const n = name.trim();
  if (!n) return 'Enter a name';
  if (n.length > 50) return 'Use at most 50 characters';
  if (/[\\/"<>|:*?\x00-\x1f]/.test(n)) return 'Leave out / \\ " < > | : * ? and control characters';
  if (!slugify(n)) return 'Use at least one letter or digit';
  return undefined;
}

/** `git config user.name`, else the login name. */
export function defaultAuthor(): string {
  try {
    const name = execFileSync('git', ['config', 'user.name'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
    if (name) return name;
  } catch {
    // No git, or no user.name.
  }
  try {
    return userInfo().username;
  } catch {
    return 'Unknown';
  }
}

export class UnsafeArchiveError extends Error {}

export interface TarEntry {
  /** `/`-separated, as stored. */
  path: string;
  type: 'file' | 'dir';
  mode: number;
  data: Buffer;
}

export interface Tarball {
  entries: TarEntry[];
  /** codeload's pax global header carries the commit as `comment`. */
  commit?: string;
}

function unsafePath(p: string): boolean {
  return p.startsWith('/') || p.includes('\\') || /^[A-Za-z]:/.test(p) || p.split('/').includes('..') || p.includes('\0');
}

/** A minimal ustar reader (plus pax and GNU long names). Throws on an entry that would land outside the target. */
export function readTar(buf: Buffer): Tarball {
  const entries: TarEntry[] = [];
  let off = 0, longName: string | undefined, commit: string | undefined;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every(b => b === 0)) break;
    const str = (a: number, b: number) => h.subarray(a, b).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(str(124, 136).trim() || '0', 8);
    if (!Number.isFinite(size) || size < 0) throw new UnsafeArchiveError(`bad size in tar header at ${off}`);
    if (off + 512 + size > buf.length) throw new UnsafeArchiveError('the archive is truncated');
    const type = h[156] ? String.fromCharCode(h[156]) : '0';
    const prefix = str(345, 500);
    let name = (prefix ? `${prefix}/` : '') + str(0, 100);
    const body = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'g' || type === 'x') {
      for (const line of body.toString('utf8').split('\n')) {
        const m = /^\d+ ([^=]+)=(.*)$/s.exec(line);
        if (!m) continue;
        if (type === 'g' && m[1] === 'comment') commit = m[2];
        if (type === 'x' && m[1] === 'path') longName = m[2];
      }
      continue;
    }
    if (type === 'L') {
      longName = body.toString('utf8').replace(/\0.*$/s, '');
      continue;
    }
    if (longName !== undefined) [name, longName] = [longName, undefined];
    if (unsafePath(name)) throw new UnsafeArchiveError(`refusing the archive: entry "${name}" points outside the target folder`);
    // Links and devices are never part of the template; skipping them keeps writes to plain files and folders.
    if (type !== '0' && type !== '5') continue;
    entries.push({ path: name.replace(/\/+$/, ''), type: type === '5' ? 'dir' : 'file', mode: parseInt(str(100, 108).trim() || '644', 8), data: body });
  }
  return { entries, commit };
}

/** Drops the archive's top folder (`decky-plugin-template-<ref>/`). */
export function stripTop(entries: TarEntry[]): TarEntry[] {
  return entries.flatMap(e => {
    const rel = e.path.split('/').slice(1).join('/');
    return rel ? [{ ...e, path: rel }] : [];
  });
}

export interface PluginSpec {
  name: string;
  author: string;
  variant: Variant;
  build: BuildTool;
  /** Version spec written for `decky-toolkit` (mcp-tool); `createPlugin` fills it in from the registry. */
  toolsPackage?: string;
}

export interface PluginFile {
  data: Buffer | string;
  mode: number;
}

// `.vscode/` holds the template's ssh/rsync deploy tasks (and a settings file with a password field), which Decky
// Toolkit's deploy and live sync replace; `backend/` is the Docker/C example for binaries.
const DROP = [/^\.vscode(\/|$)/, /^backend(\/|$)/, /^\.github(\/|$)/];
const PYTHON = [/^main\.py$/, /^decky\.pyi$/, /^py_modules(\/|$)/, /^requirements\.txt$/];
const ROLLUP_CONFIG = /^rollup\.config\.(js|mjs|ts)$/;
const ROLLUP_DEPS = /^(@decky\/rollup|rollup|@rollup\/.*|@types\/webpack)$/;

const js = (s: string) => JSON.stringify(s);

function sourceIndex(spec: PluginSpec): string {
  const name = js(spec.name);
  if (spec.variant === 'backend') {
    return `import { ButtonItem, PanelSection, PanelSectionRow, staticClasses } from "@decky/ui";
import { callable, definePlugin } from "@decky/api";
import { useState } from "react";
import { FaShip } from "react-icons/fa";

// Calls \`add\` in main.py: [arguments], return type.
const add = callable<[first: number, second: number], number>("add");

function Content() {
  const [result, setResult] = useState<number | undefined>();
  return (
    <PanelSection title="Backend">
      <PanelSectionRow>
        <ButtonItem layout="below" onClick={async () => setResult(await add(Math.random(), Math.random()))}>
          {result ?? "Add two numbers in Python"}
        </ButtonItem>
      </PanelSectionRow>
    </PanelSection>
  );
}

export default definePlugin(() => ({
  name: ${name},
  titleView: <div className={staticClasses.Title}>{${name}}</div>,
  content: <Content />,
  icon: <FaShip />,
}));
`;
  }
  const tools = spec.variant === 'mcp-tool';
  return `import { ButtonItem, PanelSection, PanelSectionRow, staticClasses } from "@decky/ui";
import { definePlugin, toaster } from "@decky/api";
import { FaShip } from "react-icons/fa";
${tools ? 'import { registerTools } from "./tools";\n' : ''}
function Content() {
  return (
    <PanelSection title=${tools ? '"MCP tool"' : '"Panel"'}>
      <PanelSectionRow>
        <ButtonItem layout="below" onClick={() => toaster.toast({ title: ${name}, body: "Hello from the frontend" })}>
          Show a toast
        </ButtonItem>
      </PanelSectionRow>
    </PanelSection>
  );
}

export default definePlugin(() => {
${tools ? '  registerTools();\n' : ''}  return {
    name: ${name},
    titleView: <div className={staticClasses.Title}>{${name}}</div>,
    content: <Content />,
    icon: <FaShip />,
  };
});
`;
}

function sourceTools(spec: PluginSpec): string {
  return `import { toaster } from "@decky/api";
import { registerTool } from "decky-toolkit/tools";
import { z } from "zod";

// Called from definePlugin: @decky/rollup's tree shaking drops a module imported only for its side effects.
// Agents connected through Decky Toolkit see this tool as <plugin directory>_show_toast while the plugin is loaded.
export function registerTools() {
  registerTool({
    name: "show_toast",
    description: "Show a toast on the device.",
    inputSchema: z.object({ text: z.string().describe("What the toast says") }),
    execute: ({ text }) => {
      toaster.toast({ title: ${js(spec.name)}, body: text });
      return "shown";
    },
  }).catch((e) => console.error("show_toast was not registered:", e));
}
`;
}

function viteConfig(): string {
  return `import { readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";

const manifest = JSON.parse(readFileSync("plugin.json", "utf-8"));

// Decky Loader provides these as window globals; the bundle must not include them.
const globals: Record<string, string> = {
  react: "SP_REACT",
  "react/jsx-runtime": "SP_JSX",
  "react-dom": "SP_REACTDOM",
  "@decky/ui": "DFL",
};

function deckyGlobals(): Plugin {
  return {
    name: "decky-globals",
    enforce: "pre",
    resolveId(id) {
      if (id in globals || id === "@decky/manifest") return \`\\0\${id}\`;
    },
    load(id) {
      if (!id.startsWith("\\0")) return;
      const name = id.slice(1);
      if (name === "@decky/manifest") return \`export default \${JSON.stringify(manifest)};\`;
      // A CommonJS shim turns named imports into property reads on the global.
      if (name in globals) return \`module.exports = \${globals[name]};\`;
    },
  };
}

export default defineConfig({
  plugins: [deckyGlobals()],
  define: { "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV || "production") },
  build: {
    lib: { entry: "src/index.tsx", formats: ["es"], fileName: "index" },
    minify: false,
    sourcemap: true,
    rolldownOptions: {
      treeshake: { propertyReadSideEffects: false },
      output: {
        exports: "default",
        sourcemapPathTransform: (p) => p.replace(/^\\.\\.\\//, \`decky://decky/plugin/\${encodeURIComponent(manifest.name)}/\`),
      },
    },
  },
});
`;
}

function readme(spec: PluginSpec, commit?: string): string {
  const from = commit ? ` (commit ${commit.slice(0, 7)})` : '';
  const backend = spec.variant === 'backend' ? '\n`main.py` is the Python backend; `src/index.tsx` calls its methods with `callable`.\n' : '';
  const tools = spec.variant === 'mcp-tool'
    ? '\n`src/tools.ts` registers an MCP tool with `registerTool` from `decky-toolkit/tools`; agents connected to the device\n'
      + 'through Decky Toolkit can call it while the plugin is loaded.\n'
    : '';
  return `# ${spec.name}

A [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader) plugin, started from
[decky-plugin-template](https://github.com/${TEMPLATE_REPO})${from}.
${backend}${tools}
## Build

\`\`\`sh
pnpm install
pnpm run build       # dist/index.js
pnpm run watch       # rebuild on change
pnpm run typecheck${spec.build === 'rollup' ? '   # the rollup build does not check types' : ''}
\`\`\`

## Run it on a device

With [Decky Toolkit](https://jackhric.github.io/decky-toolkit/) paired, \`npx decky-toolkit dev\` deploys the plugin
and pushes every change to the device. In VS Code, the Decky Toolkit extension does the same (Deploy, then
Auto-deploy on change).
`;
}

function editPluginJson(raw: string, spec: PluginSpec): string {
  const j = JSON.parse(raw);
  j.name = spec.name.trim();
  j.author = spec.author;
  // No `_root`: the backend runs as the user. No `debug`: live sync reloads in place without the loader's file watcher.
  j.flags = [];
  if (j.publish && typeof j.publish === 'object') j.publish = { ...j.publish, tags: [], description: `${spec.name.trim()}.` };
  return JSON.stringify(j, null, 2) + '\n';
}

function editPackageJson(raw: string, spec: PluginSpec): string {
  const j = JSON.parse(raw);
  j.name = slugify(spec.name);
  j.version = '0.0.1';
  j.description = `${spec.name.trim()}, a Decky Loader plugin`;
  j.author = spec.author;
  delete j.repository;
  delete j.bugs;
  delete j.homepage;
  j.keywords = ['decky', 'decky-plugin', 'steam-deck'];
  j.scripts = { ...j.scripts };
  delete j.scripts.test;
  j.scripts.typecheck = 'tsc --noEmit';
  if (spec.build === 'vite') {
    j.scripts.build = 'vite build';
    j.scripts.watch = 'vite build --watch';
    const dev = Object.fromEntries(Object.entries<string>(j.devDependencies ?? {}).filter(([k]) => !ROLLUP_DEPS.test(k)));
    j.devDependencies = sortKeys({ ...dev, vite: VITE_RANGE });
  }
  if (spec.variant === 'mcp-tool') {
    j.dependencies = sortKeys({ ...j.dependencies, zod: ZOD_RANGE, ...(spec.toolsPackage ? { 'decky-toolkit': spec.toolsPackage } : {}) });
  }
  return JSON.stringify(j, null, 2) + '\n';
}

// The template's own dependencies fail `tsc` in their .d.ts files (@decky/api wants react-router, react-icons a
// global JSX namespace), so `pnpm run typecheck` checks only the plugin's sources.
function editTsconfig(raw: string): string {
  try {
    const j = JSON.parse(raw);
    // TypeScript 6 (VS Code's own) rejects the template's "node" (node10) as deprecated, so the new project would
    // open with an error; "bundler" is what a vite/rollup build resolves like anyway.
    const resolution = String(j.compilerOptions?.moduleResolution ?? '').toLowerCase();
    j.compilerOptions = { ...j.compilerOptions, skipLibCheck: true, ...(resolution === 'node' || resolution === 'node10' ? { moduleResolution: 'bundler' } : {}) };
    return JSON.stringify(j, null, 2) + '\n';
  } catch {
    return raw;
  }
}

function sortKeys(o: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
}

function editLicense(raw: string, spec: PluginSpec, year: number): string {
  // The template's licence asks to keep its own notice (the "Original Copyright" line) and replace the first one.
  return raw.replace(/^Copyright \(c\) [^\n]*Hypothetical Plugin Developer[^\n]*$/m, `Copyright (c) ${year}, ${spec.author}`);
}

/** The new plugin's files, keyed by `/`-separated path, from the template's (top folder already stripped). */
export function pluginFiles(template: TarEntry[], spec: PluginSpec, commit?: string, year = new Date().getFullYear()): Map<string, PluginFile> {
  const python = spec.variant === 'backend';
  const files = new Map<string, PluginFile>();
  for (const e of template) {
    if (e.type !== 'file') continue;
    const rel = e.path;
    if (DROP.some(r => r.test(rel)) || (!python && PYTHON.some(r => r.test(rel))) || (spec.build === 'vite' && ROLLUP_CONFIG.test(rel))) continue;
    const mode = e.mode & 0o111 ? 0o755 : 0o644;
    const text = () => e.data.toString('utf8');
    let data: Buffer | string = e.data;
    if (rel === 'plugin.json') data = editPluginJson(text(), spec);
    else if (rel === 'package.json') data = editPackageJson(text(), spec);
    else if (rel === 'LICENSE') data = editLicense(text(), spec, year);
    else if (rel === 'tsconfig.json') data = editTsconfig(text());
    files.set(rel, { data, mode });
  }
  if (!files.has('plugin.json') || !files.has('package.json')) throw new Error('the template has no plugin.json or package.json');
  // Whole files rather than edits of the template's, which mixes several example names and comments.
  files.set('src/index.tsx', { data: sourceIndex(spec), mode: 0o644 });
  if (spec.variant === 'mcp-tool') files.set('src/tools.ts', { data: sourceTools(spec), mode: 0o644 });
  if (spec.build === 'vite') files.set('vite.config.ts', { data: viteConfig(), mode: 0o644 });
  if (python && !files.has('py_modules/.keep')) files.set('py_modules/.keep', { data: '', mode: 0o644 });
  files.set('README.md', { data: readme(spec, commit), mode: 0o644 });
  return files;
}

export const scaffoldHooks = {
  /** Gzipped tarball of the template at `ref`. Every hook is replaced in tests. */
  download: async (ref: string, signal?: AbortSignal): Promise<Buffer> => {
    const url = `https://codeload.github.com/${TEMPLATE_REPO}/tar.gz/${encodeURIComponent(ref)}`;
    const timeout = AbortSignal.timeout(60000);
    const r = await fetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (!r.ok) throw new Error(`downloading the template from ${url} failed: HTTP ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  },
  /** The latest `decky-toolkit` on npm. */
  latestTools: async (signal?: AbortSignal): Promise<string> => {
    const timeout = AbortSignal.timeout(15000);
    const r = await fetch('https://registry.npmjs.org/decky-toolkit/latest', { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    const version = r.ok ? (await r.json() as { version?: unknown }).version : undefined;
    if (typeof version !== 'string') throw new Error(`looking up decky-toolkit on npm failed: HTTP ${r.status}`);
    return version;
  },
  pnpm: () => findPnpm(),
  run: (cmd: string, cwd: string, log: (line: string) => void, signal?: AbortSignal) => runCommand(cmd, cwd, log, signal),
};

// The first release with the `decky-toolkit/tools` export (resolved through it under "bundler").
const TOOLS_FLOOR = '0.6.1';

export function templateRef(version: TemplateVersion): string {
  return version === 'pinned' ? PINNED_TEMPLATE : TEMPLATE_BRANCH;
}

export async function downloadTemplate(version: TemplateVersion, signal?: AbortSignal): Promise<Tarball> {
  const ref = templateRef(version);
  const t = readTar(gunzipSync(await scaffoldHooks.download(ref, signal)));
  return { entries: stripTop(t.entries), commit: t.commit ?? (version === 'pinned' ? ref : undefined) };
}

/** Undefined when `dir` can take a new plugin (missing or empty), else why not. */
export async function targetProblem(dir: string): Promise<string | undefined> {
  const st = await fs.stat(dir).catch(() => undefined);
  if (!st) return undefined;
  if (!st.isDirectory()) return `${dir} exists and is not a folder`;
  if ((await fs.readdir(dir)).length) return `${dir} already exists and is not empty`;
  return undefined;
}

export async function writeFiles(dir: string, files: Map<string, PluginFile>): Promise<void> {
  const problem = await targetProblem(dir);
  if (problem) throw new Error(problem);
  await fs.mkdir(dir, { recursive: true });
  for (const [rel, f] of files) {
    const dest = path.join(dir, ...rel.split('/'));
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, f.data, { mode: f.mode });
  }
}

export class CommandError extends Error {}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
// picocolors (vite, pnpm) turns colour on for any non-empty FORCE_COLOR, "0" included; NO_COLOR wins over it.
const NO_COLOR_ENV = { FORCE_COLOR: '0', NO_COLOR: '1' };

/** Runs `cmd` through the shell (pnpm.cmd and npx shims on Windows, the user's PATH); `log` gets whole lines. */
export function runCommand(cmd: string, cwd: string, log: (line: string) => void, signal?: AbortSignal): Promise<void> {
  log(`$ ${cmd}`);
  return new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, { cwd, shell: true, env: { ...process.env, ...NO_COLOR_ENV }, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '', partial = '';
    const onData = (d: Buffer) => {
      const s = d.toString();
      tail = (tail + s).slice(-2000);
      const lines = (partial + s).split('\n');
      partial = lines.pop()!;
      for (const l of lines) log(l.replace(ANSI, '').replace(/\r$/, ''));
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const abort = () => child.kill();
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', e => { signal?.removeEventListener('abort', abort); reject(e); });
    child.on('close', code => {
      signal?.removeEventListener('abort', abort);
      if (partial) log(partial.replace(ANSI, ''));
      if (signal?.aborted) return reject(signal.reason);
      if (code === 0) return resolve();
      const lines = tail.split('\n').map(l => l.replace(ANSI, '').trim()).filter(Boolean);
      const hint = [...lines].reverse().find(l => /error|ERR_/i.test(l)) ?? lines.at(-1);
      reject(new CommandError(`${cmd} exited with code ${code}${hint ? `: ${hint}` : ''}`));
    });
  });
}

/** The user's pnpm if it runs, else a pinned one through npx. Never npm or yarn: the template ships a pnpm lockfile. */
export async function findPnpm(): Promise<string> {
  const ok = await new Promise<boolean>(resolve => {
    const child = spawn('pnpm --version', { shell: true, stdio: 'ignore', env: process.env });
    const timer = setTimeout(() => { child.kill(); resolve(false); }, 15000);
    child.on('error', () => { clearTimeout(timer); resolve(false); });
    child.on('close', code => { clearTimeout(timer); resolve(code === 0); });
  });
  return ok ? 'pnpm' : `npx -y ${FALLBACK_PNPM}`;
}

export type CreatePhase = 'downloading' | 'writing' | 'installing' | 'building';

export interface CreateOptions extends PluginSpec {
  /** The new plugin's folder; it must be missing or empty. */
  dir: string;
  template: TemplateVersion;
  /** Skip `pnpm install` and the build (tests). */
  skipInstall?: boolean;
  log: (line: string) => void;
  onPhase?: (phase: CreatePhase) => void;
  signal?: AbortSignal;
}

export interface CreateResult {
  root: string;
  /** The template commit used, when known. */
  commit?: string;
  template: TemplateVersion;
  files: string[];
  /** The pnpm command used; undefined with `skipInstall`. */
  pnpm?: string;
  ms: { download: number; install: number; build: number; total: number };
}

export async function createPlugin(o: CreateOptions): Promise<CreateResult> {
  const t0 = Date.now();
  const problem = nameProblem(o.name) ?? await targetProblem(o.dir);
  if (problem) throw new Error(problem);
  const spec: PluginSpec = { ...o, name: o.name.trim() };
  o.onPhase?.('downloading');
  // An explicit range, because pnpm 11+ (minimumReleaseAge) answers a bare `pnpm add` with a release old enough
  // to lack the tools export.
  if (spec.variant === 'mcp-tool' && !spec.toolsPackage) {
    spec.toolsPackage = `^${await scaffoldHooks.latestTools(o.signal).catch(() => TOOLS_FLOOR)}`;
  }
  o.log(`Downloading ${TEMPLATE_REPO} (${o.template === 'pinned' ? `pinned ${PINNED_TEMPLATE.slice(0, 7)}` : `latest ${TEMPLATE_BRANCH}`})`);
  const t = await downloadTemplate(o.template, o.signal);
  const download = Date.now() - t0;
  o.log(`Template commit ${t.commit ?? 'unknown'} (${download} ms)`);
  o.onPhase?.('writing');
  const files = pluginFiles(t.entries, spec, t.commit);
  await writeFiles(o.dir, files);
  o.log(`Wrote ${files.size} files to ${o.dir}`);
  const result: CreateResult = { root: o.dir, commit: t.commit, template: o.template, files: [...files.keys()].sort(), ms: { download, install: 0, build: 0, total: 0 } };
  if (!o.skipInstall) {
    o.onPhase?.('installing');
    const i0 = Date.now();
    const pnpm = result.pnpm = await scaffoldHooks.pnpm();
    await scaffoldHooks.run(`${pnpm} install --no-frozen-lockfile`, o.dir, o.log, o.signal);
    result.ms.install = Date.now() - i0;
    o.onPhase?.('building');
    const b0 = Date.now();
    await scaffoldHooks.run(`${pnpm} run build`, o.dir, o.log, o.signal);
    result.ms.build = Date.now() - b0;
  }
  result.ms.total = Date.now() - t0;
  return result;
}
