// `pnpm test` (plain Node, type stripping). DECKY_SCAFFOLD_E2E=1 also downloads the pinned template, installs, builds
// and typechecks every variant with each build tool (needs the network and a built cli/, links its decky-toolkit/tools).
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import {
  BUILD_TOOLS, PINNED_TEMPLATE, UnsafeArchiveError, VARIANTS, createPlugin, nameProblem, pluginFiles, readTar, scaffoldHooks, slugify, stripTop,
  type BuildTool, type Variant,
} from '../src/scaffold.ts';

type Entry = { name: string; data?: string; type?: string; mode?: number };

function header(name: string, size: number, type: string, mode = 0o644): Buffer {
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 100), 0);
  h.write(mode.toString(8).padStart(7, '0'), 100);
  h.write(size.toString(8).padStart(11, '0'), 124);
  h.write(type, 156);
  h.write('ustar\x0000', 257);
  h.fill(' ', 148, 156);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}

const pad = (b: Buffer) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);
const pax = (kv: Record<string, string>) => Buffer.from(Object.entries(kv).map(([k, v]) => {
  const body = ` ${k}=${v}\n`;
  let len = body.length + 1;
  len += String(len).length - 1;
  return `${len}${body}`;
}).join(''));

/** A ustar archive; `g:`/`x:` names add pax headers, `L:` a GNU long name. */
function tar(entries: Entry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const data = Buffer.from(e.data ?? '');
    parts.push(header(e.name, data.length, e.type ?? '0', e.mode), pad(data));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

const TOP = 'decky-plugin-template-abc';
const TEMPLATE: Record<string, string> = {
  'plugin.json': JSON.stringify({ name: 'Example Plugin', author: 'John Doe', flags: ['debug', '_root'], api_version: 1, publish: { tags: ['template', 'root'], description: 'Decky example plugin.', image: 'x' } }),
  'package.json': JSON.stringify({
    name: 'decky-plugin-template', version: '0.0.1', type: 'module', scripts: { build: 'rollup -c', watch: 'rollup -c -w', test: 'exit 1' },
    repository: { type: 'git', url: 'x' }, bugs: { url: 'x' }, homepage: 'x', author: 'You',
    devDependencies: { '@decky/rollup': '^1.0.2', '@decky/ui': '^4.11.0', '@rollup/rollup-linux-x64-musl': '^4', '@types/webpack': '^5', rollup: '^4', typescript: '^5.6.2' },
    dependencies: { '@decky/api': '^1.1.3', 'react-icons': '^5.3.0' },
  }),
  'tsconfig.json': JSON.stringify({ compilerOptions: { moduleResolution: 'node', strict: true }, include: ['src'] }),
  'rollup.config.js': 'export default {}',
  LICENSE: 'BSD 3-Clause License\n\nCopyright (c) 2024, Hypothetical Plugin Developer\nOriginal Copyright (c) 2022-2024, Steam Deck Homebrew\n',
  'main.py': 'class Plugin: pass\n',
  'decky.pyi': '',
  'py_modules/.keep': '',
  '.vscode/defsettings.json': '{"deckpass": "ssap"}',
  'backend/Makefile': 'all:',
  'src/index.tsx': 'name: "Test Plugin"',
  'src/types.d.ts': 'declare module "*.png";',
  'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
  'README.md': '# template',
};

function templateTar(extra: Entry[] = []): Buffer {
  return tar([
    { name: 'pax_global_header', type: 'g', data: pax({ comment: 'abc123def' }).toString() },
    { name: `${TOP}/`, type: '5', mode: 0o755 },
    ...Object.entries(TEMPLATE).map(([rel, data]) => ({ name: `${TOP}/${rel}`, data })),
    { name: `${TOP}/.vscode/build.sh`, data: '#!/bin/sh', mode: 0o755 },
    ...extra,
  ]);
}

test('readTar: files, folders, pax and GNU long names, the commit from the global header', () => {
  const long = `${TOP}/${'d'.repeat(120)}/file.txt`;
  const t = readTar(templateTar([
    { name: 'PaxHeader', type: 'x', data: pax({ path: long }).toString() },
    { name: 'truncated-name', data: 'pax' },
    { name: '././@LongLink', type: 'L', data: `${TOP}/gnu-${'g'.repeat(110)}.txt` },
    { name: 'short', data: 'gnu' },
  ]));
  assert.equal(t.commit, 'abc123def');
  const byPath = new Map(t.entries.map(e => [e.path, e]));
  assert.equal(byPath.get(TOP)?.type, 'dir');
  assert.equal(byPath.get(`${TOP}/plugin.json`)?.data.toString(), TEMPLATE['plugin.json']);
  assert.equal(byPath.get(`${TOP}/.vscode/build.sh`)?.mode, 0o755);
  assert.equal(byPath.get(long)?.data.toString(), 'pax');
  assert.equal(byPath.get(`${TOP}/gnu-${'g'.repeat(110)}.txt`)?.data.toString(), 'gnu');
  assert.ok(!byPath.has('truncated-name') && !byPath.has('short'));
  assert.deepEqual(stripTop(t.entries).map(e => e.path).slice(0, 2), ['plugin.json', 'package.json'], 'the top folder itself is dropped');
});

test('readTar refuses entries outside the target and truncated archives; skips links', () => {
  for (const name of ['../evil', `${TOP}/../../etc/passwd`, '/etc/passwd', 'C:/x', `${TOP}\\..\\x`]) {
    assert.throws(() => readTar(tar([{ name, data: 'x' }])), UnsafeArchiveError, name);
  }
  assert.throws(() => readTar(tar([{ name: 'PaxHeader', type: 'x', data: pax({ path: '../../x' }).toString() }, { name: 'ok', data: 'x' }])), UnsafeArchiveError);
  const whole = tar([{ name: 'a', data: 'x'.repeat(2000) }]);
  assert.throws(() => readTar(whole.subarray(0, 1024)), /truncated/);
  const links = readTar(tar([{ name: `${TOP}/link`, type: '2' }, { name: `${TOP}/hard`, type: '1' }, { name: `${TOP}/f`, data: 'x' }]));
  assert.deepEqual(links.entries.map(e => e.path), [`${TOP}/f`]);
});

test('names: validation and folder slugs', () => {
  assert.equal(slugify('  Scaffold Test! '), 'scaffold-test');
  assert.equal(slugify('Café Déjà'), 'cafe-deja');
  assert.equal(nameProblem('Scaffold Test'), undefined);
  assert.equal(nameProblem("Deck's {Best} Plugin"), undefined);
  for (const bad of ['', '   ', 'a/b', 'a\\b', 'say "hi"', '!!!', 'x'.repeat(51)]) assert.ok(nameProblem(bad), bad);
});

const entries = () => stripTop(readTar(templateTar()).entries);

test('pluginFiles: renames, flags, dropped folders and the files of each variant and build tool', () => {
  for (const variant of VARIANTS) {
    for (const build of BUILD_TOOLS) {
      const files = pluginFiles(entries(), { name: "Deck's {Best} Plugin", author: 'Ada', variant, build }, 'abc123def', 2026);
      const text = (rel: string) => String(files.get(rel)?.data);
      const what = `${variant}/${build}`;
      const keys = [...files.keys()];
      assert.ok(!keys.some(k => k.startsWith('.vscode/') || k.startsWith('backend/')), `${what}: ssh tasks and the C example are gone`);
      const manifest = JSON.parse(text('plugin.json'));
      assert.deepEqual([manifest.name, manifest.author, manifest.flags, manifest.publish.tags], ["Deck's {Best} Plugin", 'Ada', [], []], what);
      const pkg = JSON.parse(text('package.json'));
      assert.equal(pkg.name, 'deck-s-best-plugin');
      assert.equal(pkg.author, 'Ada');
      assert.ok(!('repository' in pkg) && !('bugs' in pkg) && !('homepage' in pkg) && !('test' in pkg.scripts), what);
      assert.equal(pkg.scripts.typecheck, 'tsc --noEmit');
      assert.equal(JSON.parse(text('tsconfig.json')).compilerOptions.skipLibCheck, true);
      assert.equal(JSON.parse(text('tsconfig.json')).compilerOptions.moduleResolution, 'node', 'the rest of the template config stays');
      assert.match(text('LICENSE'), /^Copyright \(c\) 2026, Ada\nOriginal Copyright \(c\) 2022-2024, Steam Deck Homebrew$/m);
      assert.match(text('README.md'), /^# Deck's \{Best\} Plugin$/m);
      assert.match(text('README.md'), /commit abc123d/);
      const index = text('src/index.tsx');
      assert.ok(index.includes(`name: "Deck's {Best} Plugin"`) && index.includes(`{"Deck's {Best} Plugin"}</div>`), `${what}: the name is a string literal`);
      assert.ok(!/Test Plugin|Example Plugin/.test(index));
      assert.equal(files.has('pnpm-lock.yaml'), true);
      assert.equal(files.has('main.py') && files.has('decky.pyi') && files.has('py_modules/.keep'), variant === 'backend', `${what}: Python files`);
      assert.equal(index.includes('callable<'), variant === 'backend');
      assert.equal(files.has('src/tools.ts'), variant === 'mcp-tool');
      assert.equal(index.includes('registerTools();'), variant === 'mcp-tool', `${what}: tools are registered from definePlugin`);
      if (variant === 'mcp-tool') {
        assert.match(text('src/tools.ts'), /from "decky-toolkit\/tools"/);
        assert.equal(pkg.dependencies.zod, '^4.2.0');
        assert.equal(pkg.dependencies['decky-toolkit'], undefined, 'createPlugin fills it in');
      }
      assert.equal(files.has('rollup.config.js'), build === 'rollup');
      assert.equal(files.has('vite.config.ts'), build === 'vite');
      if (build === 'vite') {
        assert.deepEqual([pkg.scripts.build, pkg.scripts.watch], ['vite build', 'vite build --watch']);
        assert.deepEqual(Object.keys(pkg.devDependencies), ['@decky/ui', 'typescript', 'vite']);
        assert.match(text('vite.config.ts'), /fileName: "index"/);
      } else {
        assert.deepEqual([pkg.scripts.build, pkg.scripts.watch], ['rollup -c', 'rollup -c -w'], 'live sync runs the watch script');
        assert.ok('@decky/rollup' in pkg.devDependencies);
      }
    }
  }
  const pinned = pluginFiles(entries(), { name: 'X', author: 'A', variant: 'mcp-tool', build: 'rollup', toolsPackage: 'link:../cli' });
  assert.equal(JSON.parse(String(pinned.get('package.json')?.data)).dependencies['decky-toolkit'], 'link:../cli');
});

test('createPlugin writes the folder from a downloaded tarball and refuses a folder that is in use', async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'decky-scaffold-'));
  const original = scaffoldHooks.download;
  const refs: string[] = [];
  const latestTools = scaffoldHooks.latestTools;
  scaffoldHooks.download = async ref => { refs.push(ref); return gzipSync(templateTar()); };
  try {
    const dir = path.join(scratch, 'scaffold-test');
    const phases: string[] = [];
    const r = await createPlugin({ name: ' Scaffold Test ', author: 'Ada', variant: 'backend', build: 'rollup', template: 'pinned', dir, skipInstall: true, log: () => {}, onPhase: p => phases.push(p) });
    assert.deepEqual(refs, [PINNED_TEMPLATE]);
    assert.deepEqual(phases, ['downloading', 'writing']);
    assert.equal(r.commit, 'abc123def');
    assert.equal(JSON.parse(readFileSync(path.join(dir, 'plugin.json'), 'utf8')).name, 'Scaffold Test');
    assert.ok(existsSync(path.join(dir, 'main.py')) && !existsSync(path.join(dir, '.vscode')));
    assert.deepEqual(readdirSync(dir).sort(), r.files.filter(f => !f.includes('/')).concat(['py_modules', 'src']).sort());
    await createPlugin({ name: 'L', author: 'A', variant: 'frontend', build: 'vite', template: 'latest', dir: path.join(scratch, 'latest'), skipInstall: true, log: () => {} });
    assert.equal(refs[1], 'main', 'latest is the default branch');
    await assert.rejects(createPlugin({ name: 'Again', author: 'A', variant: 'frontend', build: 'rollup', template: 'pinned', dir, skipInstall: true, log: () => {} }), /not empty/);
    writeFileSync(path.join(scratch, 'file'), '');
    await assert.rejects(createPlugin({ name: 'F', author: 'A', variant: 'frontend', build: 'rollup', template: 'pinned', dir: path.join(scratch, 'file'), skipInstall: true, log: () => {} }), /not a folder/);
    await assert.rejects(createPlugin({ name: 'a/b', author: 'A', variant: 'frontend', build: 'rollup', template: 'pinned', dir: path.join(scratch, 'n'), skipInstall: true, log: () => {} }), /Leave out/);
    assert.equal(refs.length, 2, 'nothing is downloaded for a bad name or folder');
    const toolsRange = async (latest: () => Promise<string>) => {
      scaffoldHooks.latestTools = latest;
      const d = mkdtempSync(path.join(scratch, 'tools-'));
      await createPlugin({ name: 'T', author: 'A', variant: 'mcp-tool', build: 'rollup', template: 'pinned', dir: d, skipInstall: true, log: () => {} });
      return JSON.parse(readFileSync(path.join(d, 'package.json'), 'utf8')).dependencies['decky-toolkit'];
    };
    assert.equal(await toolsRange(async () => '0.9.2'), '^0.9.2', 'the latest release, as an explicit range');
    assert.equal(await toolsRange(async () => { throw new Error('offline'); }), '^0.6.1', 'offline: a release that has decky-toolkit/tools');
  } finally {
    scaffoldHooks.download = original;
    scaffoldHooks.latestTools = latestTools;
    rmSync(scratch, { recursive: true, force: true });
  }
});

const cliDir = path.resolve(import.meta.dirname, '..', '..', '..', 'cli');

test('every variant with each build tool installs, builds and typechecks', { skip: !process.env.DECKY_SCAFFOLD_E2E && 'set DECKY_SCAFFOLD_E2E=1' }, async () => {
  assert.ok(existsSync(path.join(cliDir, 'dist', 'tools.d.ts')), 'build cli/ first');
  const scratch = mkdtempSync(path.join(tmpdir(), 'decky-scaffold-e2e-'));
  try {
    for (const variant of VARIANTS) {
      for (const build of BUILD_TOOLS) {
        const dir = path.join(scratch, `${variant}-${build}`);
        const log: string[] = [];
        // The released decky-toolkit may predate a change to tools; the local build is what this checks.
        const toolsPackage = variant === 'mcp-tool' ? `link:${cliDir}` : undefined;
        const r = await createPlugin({ name: 'E2E Test', author: 'CI', variant: variant as Variant, build: build as BuildTool, template: 'pinned', dir, toolsPackage, log: l => log.push(l) });
        assert.ok(statSync(path.join(dir, 'dist', 'index.js')).size > 1000, `${variant}/${build}: dist/index.js`);
        if (variant === 'mcp-tool') assert.match(readFileSync(path.join(dir, 'dist', 'index.js'), 'utf8'), /show_toast/, 'the tool survives tree shaking');
        execSync('npx tsc --noEmit', { cwd: dir, stdio: 'pipe' });
        console.log(`${variant}/${build}: install ${r.ms.install} ms, build ${r.ms.build} ms`);
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
