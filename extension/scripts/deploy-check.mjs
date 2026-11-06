// Deploys a throwaway skeleton plugin through the extension's own deploy code (no VS Code) and
// checks that a fast deploy (restart=plugin) replaces both the backend and the frontend bundle.
// Usage: DECKY_IDENTITY_FILE=/path/to/identity.json node scripts/deploy-check.mjs <plugin-root> [host] [port]
//   <plugin-root> is a decky-plugin-template checkout named "Decky Toolkit Test" whose src/version.ts
//   exports VERSION, whose py_modules/testver/__init__.py defines VERSION and whose frontend sets
//   window.__deckyToolkitTestVersion = VERSION. The script rewrites those files for each round.
// Set KEEP=1 to leave the plugin installed; otherwise Decky uninstalls it (no loader restart) and
// ssh removes its logs and settings. Only the full-restart round restarts the loader.
import * as esbuild from 'esbuild';
import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import * as path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const pluginRoot = process.argv[2];
const host = process.argv[3] ?? process.env.DECKY_HOST;
const port = Number(process.argv[4] ?? process.env.DECKY_PORT ?? 8765);
const sshTarget = process.env.DECKY_SSH ?? (process.env.DECKY_USER && `${process.env.DECKY_USER}@${host}`);
const identityFile = process.env.DECKY_IDENTITY_FILE;
if (!identityFile || !pluginRoot || !host || !sshTarget) {
  console.error('Usage: DECKY_IDENTITY_FILE=<file> DECKY_USER=<ssh user> node scripts/deploy-check.mjs <plugin-root> <host> [port]\n(DECKY_HOST and DECKY_SSH=<user@host> also work)');
  process.exit(2);
}
// The identity file (~/.config/decky-toolkit/identity.json: {version, device, key, cert, serverCert}) or the
// older secret-storage JSON {key, cert, serverCert}.
const { key, cert, serverCert } = JSON.parse(readFileSync(identityFile, 'utf8'));
const identity = { key, cert, serverCert };
const redact = s => String(s).split(identity.key).join('<key>');

const outfile = path.join(root, 'out', 'deploylib.cjs');
await esbuild.build({
  stdin: { contents: "export * from '../packages/client/src/client'; export * from '../packages/client/src/deploy';", resolveDir: root, loader: 'ts' },
  bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'warning',
});
const lib = createRequire(import.meta.url)(outfile);
const { DeckyClient, isConnectionError, readWorkspacePlugin, deployPlugin, newLines, sleep } = lib;
const client = new DeckyClient({ host, port }, identity);

const verbose = !!process.env.VERBOSE;
const log = line => { if (verbose) console.log('      ' + line); };
const results = [];
const timings = [];

async function check(name, fn) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const detail = await fn();
      results.push(true);
      console.log(`PASS  ${name}: ${detail}`);
      return;
    } catch (e) {
      const conn = isConnectionError(e) || /ECONNREFUSED|ECONNRESET|HTTP 502|cannot reach/.test(String(e?.message));
      if (attempt === 1 && conn) {
        console.log(`....  ${name}: connection error (${redact(e.message)}); retrying in 30 s`);
        await sleep(30000);
        continue;
      }
      results.push(false);
      console.log(`FAIL  ${name}: ${redact(e.stack ?? e)}`);
      return;
    }
  }
}

// Leaves unchanged files alone so their mtimes (and so the build decision) stay as they are.
const put = (rel, text) => {
  const file = path.join(pluginRoot, rel);
  if (readFileSync(file, 'utf8') !== text) writeFileSync(file, text);
};

function setVersion(v, { debug = true } = {}) {
  put('src/version.ts', `export const VERSION = "${v}";\n`);
  put('py_modules/testver/__init__.py', `VERSION = "${v}"\n`);
  const pkgFile = path.join(pluginRoot, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
  pkg.version = `${v.slice(1)}.0.0`;
  writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');
  const metaFile = path.join(pluginRoot, 'plugin.json');
  const meta = JSON.parse(readFileSync(metaFile, 'utf8'));
  meta.flags = debug ? ['debug'] : [];
  writeFileSync(metaFile, JSON.stringify(meta, null, 2) + '\n');
}

const evaluate = async expression => {
  const value = await client.evaluate(expression);
  return typeof value === 'string' ? value : JSON.stringify(value);
};
const FRONTEND = "JSON.stringify({ bundle: window.__deckyToolkitTestVersion ?? null, " +
  "listed: window.DeckyPluginLoader?.plugins?.find(p => p.name === 'Decky Toolkit Test')?.version ?? null })";

async function frontendState(want, timeoutMs = 10000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    try {
      last = JSON.parse(await evaluate(FRONTEND));
      if (typeof last === 'string') last = JSON.parse(last);
    } catch (e) {
      last = { error: String(e.message) };
    }
    if (last?.bundle === want) return { ...last, ms: Date.now() - start };
    await sleep(250);
  }
  return { ...last, ms: Date.now() - start };
}

async function backendVersion() {
  const raw = await evaluate("window.DeckyBackend.call('loader/call_plugin_method', 'Decky Toolkit Test', 'version')");
  try { return JSON.parse(raw); } catch { return raw; }
}

const LOADED = /\[loader\]\[INFO\]: Loaded Decky Toolkit Test /;
const journal = () => client.logTail({ source: 'loader', tail: 300 });
const backendProcesses = () =>
  Number(execFileSync('ssh', [sshTarget, "pgrep -fc '^Decky Toolkit Test ' || true"]).toString().trim() || 0);

async function round(label, v, restart, opts = {}) {
  setVersion(v, opts);
  const p = await readWorkspacePlugin(pluginRoot, 'decky-toolkit-test');
  const before = await journal();
  const t0 = Date.now();
  const r = await deployPlugin(client, p, { restart, build: 'auto', log, confirmTimeoutMs: 10000 });
  const deployMs = Date.now() - t0;
  const full = r.restarted === 'loader';
  const fe = await frontendState(v, full ? 30000 : 10000);
  const be = await backendVersion().catch(e => `error: ${e.message}`);
  const wall = Date.now() - t0;
  // A reload after the confirmation, or an orphaned backend, shows up later.
  await sleep(6000);
  const loads = newLines(before, await journal()).filter(l => LOADED.test(l)).length;
  const beLater = await backendVersion().catch(e => `error: ${e.message}`);
  const procs = backendProcesses();
  const listed = (await client.listPlugins()).find(x => x.dir === 'decky-toolkit-test');
  timings.push({ label, via: r.via, deployMs, wallMs: wall, build: r.build, confirm: r.confirm, loads });
  const detail = `via=${r.via} restart=${r.restarted} build=${r.build.ran ? `${r.build.ms} ms (${r.build.reason})` : `skipped (${r.build.reason})`}, ` +
    `stage ${r.stageMs} ms (${(r.zipBytes / 1024).toFixed(0)} KiB), upload ${r.uploadMs} ms, ` +
    `confirm ${r.confirm ? `${r.confirm.confirmed}${r.confirm.nudged ? ' (nudged)' : ''} in ${r.confirm.ms} ms (${r.confirm.detail})` : 'n/a'}; ` +
    `deploy ${(deployMs / 1000).toFixed(2)} s, frontend ${JSON.stringify({ bundle: fe.bundle, listed: fe.listed })} after +${fe.ms} ms, ` +
    `backend ${JSON.stringify(be)} (6 s later ${JSON.stringify(beLater)}), "Loaded" lines ${loads}, backend processes ${procs}, /plugins version ${listed?.version}`;
  const ok = fe.bundle === v && be === v && beLater === v && listed?.version === `${v.slice(1)}.0.0` &&
    (!r.confirm || r.confirm.confirmed) && (full || loads === r.confirm?.loads) && procs === 1;
  if (!ok) throw new Error(detail);
  return detail;
}

// A loader restart while a stream is live has crashed gamescope, so wait for viewers to leave.
async function noViewers(timeoutMs = 300000) {
  if (process.env.IGNORE_VIEWERS) return true;
  const start = Date.now();
  for (;;) {
    const s = await client.streamStats().catch(() => undefined);
    if (!s?.subscribers) return true;
    if (Date.now() - start > timeoutMs) return false;
    await sleep(5000);
  }
}

console.log(`device ${host}:${port}, plugin ${pluginRoot}`);
await check('test plugin is not installed yet', async () => {
  const listed = (await client.listPlugins()).map(p => p.dir);
  if (listed.includes('decky-toolkit-test')) throw new Error('decky-toolkit-test already installed; remove it first');
  return listed.join(', ');
});
if (!(await noViewers())) {
  console.log('a stream viewer stayed connected for 5 min; the first install restarts the loader, giving up');
  process.exit(1);
}
await check('v1: first install (restarts the loader)', () => round('v1 first install', 'v1', undefined));
await check('v2: fast deploy, debug flag (loader watcher reloads it)', () => round('v2 fast, debug', 'v2', undefined));
await check('v3: fast deploy, no debug flag (restart=plugin)', () => round('v3 fast, no debug', 'v3', undefined, { debug: false }));
await check('v4: fast deploy, no debug flag, nothing to build', async () => {
  setVersion('v4', { debug: false });
  execFileSync('pnpm', ['run', 'build'], { cwd: pluginRoot, stdio: 'ignore' });
  return round('v4 fast, prebuilt', 'v4', undefined, { debug: false });
});
if (process.env.SKIP_FULL) {
  console.log('SKIP  v5: full restart deploy (SKIP_FULL set)');
} else if (!(await noViewers())) {
  console.log('SKIP  v5: full restart deploy: a stream viewer stayed connected for 5 min');
} else {
  await check('v5: full restart deploy, debug flag (restart=loader)', () => round('v5 full, debug', 'v5', 'loader'));
}

if (!process.env.KEEP) {
  // Decky's own uninstall stops the backend, unloads the frontend and removes the dir, no restart.
  await check('cleanup: uninstall decky-toolkit-test through Decky', async () => {
    await evaluate("window.DeckyBackend.call('utilities/uninstall_plugin', 'Decky Toolkit Test')");
    execFileSync('ssh', [sshTarget, 'sudo rm -rf ~/homebrew/plugins/decky-toolkit-test ~/homebrew/logs/decky-toolkit-test ~/homebrew/settings/decky-toolkit-test ~/homebrew/data/decky-toolkit-test']);
    const fe = await evaluate("String(window.DeckyPluginLoader.plugins.some(p => p.name === 'Decky Toolkit Test'))");
    if (!/false/.test(fe)) throw new Error(`frontend still lists the plugin (${fe})`);
    if (backendProcesses()) throw new Error('a backend process is still running');
    const listed = (await client.listPlugins()).map(p => p.dir);
    if (listed.includes('decky-toolkit-test')) throw new Error(`still listed: ${listed}`);
    const left = execFileSync('ssh', [sshTarget, 'ls -d ~/homebrew/*/decky-toolkit-test 2>/dev/null || true']).toString().trim();
    if (left) throw new Error(`left behind: ${left}`);
    return `plugins now: ${listed.join(', ')}`;
  });
}

console.log('\ntimings:');
for (const t of timings) {
  console.log(`  ${t.label.padEnd(24)} via=${t.via.padEnd(7)} deploy ${(t.deployMs / 1000).toFixed(2)} s, until frontend+backend verified ${(t.wallMs / 1000).toFixed(2)} s` +
    `${t.build.ran ? `, build ${(t.build.ms / 1000).toFixed(2)} s` : ''}`);
}
const failed = results.filter(r => !r).length;
console.log(failed ? `\n${failed} check(s) failed` : `\nall ${results.length} checks passed`);
process.exit(failed ? 1 : 0);
