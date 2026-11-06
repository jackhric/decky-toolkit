// Builds the CLI, then runs it as a child process against a fake device (scripts/fake-device.mjs, wired in through
// the shared client's hooks). Needs no device. Usage: node scripts/smoke.mjs
import * as esbuild from 'esbuild';
import assert from 'assert/strict';
import { execFileSync, spawn } from 'child_process';
import { generateKeyPairSync } from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { options } from '../esbuild.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

await esbuild.build({ ...options, logLevel: 'warning' });
const bundle = readFileSync('dist/cli.js', 'utf8');
assert.ok(bundle.startsWith('#!/usr/bin/env node\n'), 'dist/cli.js starts with the node shebang');
assert.ok(!/require\("(vscode|esbuild)"\)/.test(bundle), 'the bundle has no runtime dependencies');

const harness = path.join(root, 'out', 'harness.cjs');
await esbuild.build({
  ...options,
  entryPoints: undefined,
  banner: undefined,
  stdin: {
    contents: "import { transportHooks, TrustError } from '../packages/client/src/transport';"
      + "import { discoveryHooks, discoveryTimings } from '../packages/client/src/discovery';"
      + "import { pairingTimings } from '../packages/client/src/pairing';"
      + "import { installFake } from './scripts/fake-device.mjs';"
      + "import { main } from './src/main';"
      + 'installFake({ transportHooks, TrustError, discoveryHooks, discoveryTimings, pairingTimings });'
      + 'void main(process.argv.slice(2)).then(code => { process.exitCode = code; });',
    resolveDir: root,
    loader: 'ts',
  },
  outfile: harness,
  logLevel: 'warning',
});

// Throwaway device identity, as the plugin mints it: a self-signed CA/server certificate and a client certificate it signed.
const certDir = mkdtempSync(path.join(tmpdir(), 'decky-cli-smoke-certs-'));
const ossl = (...args) => execFileSync('openssl', args, { cwd: certDir, stdio: ['ignore', 'pipe', 'pipe'] });
ossl('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', 'server.key', '-out', 'server.crt',
  '-days', '2', '-subj', '/CN=Decky Toolkit', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,digitalSignature,keyCertSign');
writeFileSync(path.join(certDir, 'client.key'), generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }));
writeFileSync(path.join(certDir, 'client.ext'), 'extendedKeyUsage=clientAuth\nkeyUsage=digitalSignature\n');
ossl('req', '-new', '-key', 'client.key', '-subj', '/CN=CLI on smoke', '-out', 'client.csr');
ossl('x509', '-req', '-in', 'client.csr', '-CA', 'server.crt', '-CAkey', 'server.key', '-CAcreateserial', '-days', '2', '-extfile', 'client.ext', '-out', 'client.crt');

const scratch = mkdtempSync(path.join(tmpdir(), 'decky-cli-smoke-'));
const configDir = path.join(scratch, 'config');
const identityPath = path.join(configDir, 'identity.json');
const fakeDir = path.join(scratch, 'device');
mkdirSync(fakeDir);
const frame = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
const health = { ok: true, name: 'decky-toolkit', version: '0.2.1', api_version: 2, tools: 2, hostname: 'steamdeck.local', device_id: 'dev-1', os: 'SteamOS' };
const stateFile = path.join(fakeDir, 'state.json');
const state = () => JSON.parse(readFileSync(stateFile, 'utf8'));
const setState = patch => writeFileSync(stateFile, JSON.stringify({ ...state(), ...patch }, null, 2));
writeFileSync(stateFile, JSON.stringify({
  hosts: ['192.168.77.20', '127.0.0.1'], discoverable: ['192.168.77.20:8765'], health, downFor: 0,
  serverCert: readFileSync(path.join(certDir, 'server.crt'), 'utf8'), clientCert: readFileSync(path.join(certDir, 'client.crt'), 'utf8'),
  journal: ['boot'], pairQueue: [], pairRequests: [], pairCancelled: [], requests: [], rpc: [], installs: [], reloads: [],
  plugins: [{ dir: 'my-plugin', name: 'My Plugin', version: '1.0.0', flags: [] }], installMeta: { name: 'My Plugin', version: '1.2.3' },
  tools: [
    { name: 'decky_status', description: 'Loader status', inputSchema: { type: 'object', properties: {} } },
    { name: 'screen_capture', description: 'Screenshot', inputSchema: { type: 'object', properties: {} } },
  ],
  frameB64: frame.toString('base64'),
}));
const env = { ...process.env, DECKY_TOOLKIT_CONFIG_DIR: configDir, FAKE_DEVICE: fakeDir };

/** Runs the CLI to completion; `onSpawn` and `onStdout` may write to stdin or signal the child. */
function cli(args, { input, onSpawn, onStdout, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [harness, ...args], { cwd: scratch, env, stdio: ['pipe', 'pipe', 'pipe'] });
    onSpawn?.(child);
    let stdout = '', stderr = '';
    const t = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${args.join(' ')} timed out\nstdout: ${stdout}\nstderr: ${stderr}`)); }, timeoutMs);
    child.stdout.on('data', d => { stdout += d; onStdout?.(stdout, child); });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', code => { clearTimeout(t); resolve({ code, stdout, stderr }); });
    if (input !== undefined) child.stdin.end(input);
    else if (!onStdout) child.stdin.end();
  });
}

const results = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    results.push(true);
    console.log(`PASS  ${name}${detail ? `: ${detail}` : ''}`);
  } catch (e) {
    results.push(false);
    console.log(`FAIL  ${name}: ${e.stack ?? e}`);
  }
}

await check('--version and --help', async () => {
  const v = await cli(['--version']);
  assert.equal(v.code, 0);
  assert.equal(v.stdout.trim(), pkg.version);
  const h = await cli(['--help']);
  assert.equal(h.code, 0);
  assert.match(h.stdout, /claude mcp add decky -- npx -y decky-toolkit mcp/);
  const none = await cli([]);
  assert.equal(none.code, 2);
  return `version ${pkg.version}`;
});

await check('usage errors exit 2', async () => {
  for (const args of [['frobnicate'], ['status', '--restart', 'none'], ['deploy', '--restart', 'sometimes'], ['call'], ['call', 'x', '{bad'], ['pair', 'a:b:c'], ['pair', 'steamdeck:99999'], ['forget', 'extra']]) {
    const r = await cli(args);
    assert.equal(r.code, 2, `${args.join(' ')} → ${r.code} ${r.stderr}`);
    assert.match(r.stderr, /--help/);
  }
});

await check('status and call before pairing', async () => {
  const s = await cli(['status', '--json']);
  assert.equal(s.code, 1);
  const j = JSON.parse(s.stdout);
  assert.equal(j.identity, false);
  assert.match(j.error, /decky-toolkit pair/);
  const c = await cli(['call', 'decky_status']);
  assert.equal(c.code, 1);
  assert.match(c.stderr, /not paired.*decky-toolkit pair/);
});

await check('pair with no device on the network', async () => {
  setState({ discoverable: [] });
  const r = await cli(['pair']);
  setState({ discoverable: ['192.168.77.20:8765'] });
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /No device found on 192\.168\.77\.0\/24/);
  assert.equal(existsSync(identityPath), false);
});

await check('pair cancelled with Ctrl-C withdraws the request', async () => {
  let sent = false;
  const r = await cli(['pair', '192.168.77.20'], {
    onStdout: (out, child) => { if (!sent && /Approve on the device · code \d{4}/.test(out)) { sent = true; child.kill('SIGINT'); } },
  });
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /Cancelled/);
  const s = state();
  assert.deepEqual(s.pairCancelled, [s.pairRequests.at(-1).id]);
  assert.equal(existsSync(identityPath), false);
});

await check('pair by discovery with a scripted approval', async () => {
  setState({ pairQueue: ['pending', 'approved'] });
  const r = await cli(['pair', '--name', 'Smoke CLI']);
  assert.equal(r.code, 0, r.stderr);
  const req = state().pairRequests.at(-1);
  assert.equal(req.client_name, 'Smoke CLI');
  assert.equal(req.client_kind, 'mcp');
  // The CLI derives the code itself; it must be the one the device shows.
  assert.match(r.stdout, new RegExp(`Approve on the device · code ${req.code}\\n`));
  assert.match(r.stdout, /Paired with steamdeck \(192\.168\.77\.20:8765\)/);
  const f = JSON.parse(readFileSync(identityPath, 'utf8'));
  assert.deepEqual(f.device, { host: '192.168.77.20', port: 8765, name: 'steamdeck', deviceId: 'dev-1' });
  assert.equal(f.version, 1);
  assert.equal(f.cert, state().clientCert);
  assert.match(f.key, /BEGIN PRIVATE KEY/);
  assert.equal(statSync(identityPath).mode & 0o777, 0o600);
  return `code ${req.code}, identity written`;
});

await check('pair again with the paired device', async () => {
  const before = state().pairRequests.length;
  const r = await cli(['pair', '192.168.77.20:8765']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Already paired with steamdeck/);
  assert.equal(state().pairRequests.length, before);
});

await check('status', async () => {
  const r = await cli(['status']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Device\s+steamdeck \(192\.168\.77\.20:8765\)/);
  assert.match(r.stdout, /Plugin\s+decky-toolkit 0\.2\.1, api 2, 2 tools/);
  assert.match(r.stdout, /Paired\s+yes/);
  const j = JSON.parse((await cli(['status', '--json'])).stdout);
  assert.equal(j.paired, true);
  assert.equal(j.reachable, true);
  assert.equal(j.plugin.apiVersion, 2);
});

await check('call', async () => {
  const t = await cli(['call', 'decky_status', '{"verbose":true}']);
  assert.equal(t.code, 0, t.stderr);
  assert.deepEqual(JSON.parse(t.stdout), { loader: 'v3.3.1', args: { verbose: true } });
  const target = path.join(scratch, 'shot.jpg');
  const i = await cli(['call', 'screen_capture', '--out', target]);
  assert.equal(i.code, 0, i.stderr);
  assert.deepEqual(readFileSync(target), frame);
  assert.match(i.stdout, /1920x1080/);
  const d = await cli(['call', 'screen_capture']);
  const saved = /Saved image\/jpeg to (\S+screen_capture-\S+\.jpg)/.exec(d.stdout);
  assert.ok(saved, d.stdout);
  assert.deepEqual(readFileSync(saved[1]), frame);
  const bad = await cli(['call', 'nope']);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /Unknown tool: nope/);
});

const plugin = path.join(scratch, 'checkout-of-my-plugin');
mkdirSync(path.join(plugin, 'dist'), { recursive: true });
mkdirSync(path.join(plugin, 'src'));
writeFileSync(path.join(plugin, 'plugin.json'), JSON.stringify({ name: 'My Plugin', flags: [] }));
writeFileSync(path.join(plugin, 'package.json'), JSON.stringify({ name: 'my-plugin', version: '1.2.3' }));
writeFileSync(path.join(plugin, 'dist', 'index.js'), 'export default 1;\n');
writeFileSync(path.join(plugin, 'main.py'), 'class Plugin: pass\n');
writeFileSync(path.join(plugin, 'src', 'index.tsx'), 'not shipped\n');

/** Drives `mcp` over stdio, sending each message once the previous request was answered. */
async function mcp(messages) {
  const queue = [...messages];
  const next = child => {
    while (queue.length) {
      const m = queue.shift();
      child.stdin.write(typeof m === 'string' ? m + '\n' : JSON.stringify(m) + '\n');
      if (typeof m === 'string' || 'id' in m) return;
    }
    child.stdin.end();
  };
  let answered = 0;
  const r = await cli(['mcp'], {
    timeoutMs: 60000,
    onSpawn: next,
    onStdout: (stdout, child) => { for (const n = stdout.split('\n').length - 1; answered < n; answered++) next(child); },
  });
  const lines = r.stdout.split('\n');
  const trailing = lines.pop();
  const replies = new Map();
  for (const line of lines) {
    try { const msg = JSON.parse(line); replies.set(msg.id, msg); } catch { /* checked by the caller */ }
  }
  return { ...r, replies, lines, trailing };
}

await check('mcp over stdio', async () => {
  const t0 = Date.now();
  const r = await mcp([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'decky_status', arguments: { a: 1 } } },
    { jsonrpc: '2.0', id: 'four', method: 'tools/call', params: { name: 'screen_capture', arguments: {} } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'device_status', arguments: {} } },
    { jsonrpc: '2.0', id: 6, method: 'resources/list' },
    '{not json',
    { jsonrpc: '2.0', id: 7, method: 'ping' },
    { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'deploy_plugin', arguments: { dir: plugin, restart: 'none' } } },
    '[{"jsonrpc":"2.0","id":9,"method":"ping"}]',
    { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'deploy_plugin', arguments: { restart: 'sometimes' } } },
  ]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.trailing, '', 'stdout ends with a newline');
  for (const line of r.lines) {
    const msg = JSON.parse(line);
    assert.equal(msg.jsonrpc, '2.0', line);
    assert.ok('result' in msg || 'error' in msg, line);
  }
  assert.equal(r.lines.length, 11, `one line per request: ${r.stdout}`);
  assert.deepEqual(r.lines.map(l => JSON.parse(l)).filter(m => m.id === null).map(m => m.error.code), [-32700, -32600], 'a parse error, then a batch as an Invalid Request');
  assert.ok(!r.replies.has(9), 'nothing in the batch ran');
  assert.deepEqual([r.replies.get(10).result.isError, r.replies.get(10).result.content[0].text], [true, 'restart must be one of none, plugin, loader']);
  const init = r.replies.get(1).result;
  assert.equal(init.protocolVersion, '2025-06-18');
  assert.deepEqual(init.serverInfo, { name: 'decky-toolkit', version: pkg.version });
  assert.deepEqual(init.capabilities, { tools: { listChanged: false } });
  assert.equal(typeof init.instructions, 'string');
  assert.deepEqual(r.replies.get(2).result.tools.map(t => t.name), ['decky_status', 'screen_capture', 'deploy_plugin', 'device_status']);
  assert.equal(r.replies.get(3).result.isError, false);
  assert.deepEqual(JSON.parse(r.replies.get(3).result.content[0].text).args, { a: 1 });
  assert.deepEqual(r.replies.get('four').result.content[0], { type: 'image', data: frame.toString('base64'), mimeType: 'image/jpeg' });
  assert.equal(JSON.parse(r.replies.get(5).result.content[0].text).paired, true);
  assert.equal(r.replies.get(6).error.code, -32601);
  assert.deepEqual(r.replies.get(7).result, {});
  const dep = r.replies.get(8).result;
  assert.equal(dep.isError, false, dep.content[0].text);
  const d = JSON.parse(dep.content[0].text);
  assert.equal(d.plugin.dir, 'my-plugin');
  assert.equal(d.restarted, 'none');
  assert.equal(d.reloaded, null);
  // tools/list went to the device once; later calls reuse it.
  assert.equal(state().rpc.filter(m => m === 'tools/list').length, 1);
  return `${r.lines.length} replies in ${Date.now() - t0} ms, stderr ${r.stderr.length} B`;
});

await check('initialize answers without the device', async () => {
  const hosts = state().hosts;
  setState({ hosts: [] });
  try {
    const t0 = Date.now();
    const r = await mcp([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'decky_status', arguments: {} } },
    ]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.replies.get(1).result.protocolVersion, '2025-11-25');
    assert.deepEqual(r.replies.get(2).result.tools.map(t => t.name), ['deploy_plugin', 'device_status']);
    const res = r.replies.get(3).result;
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /cannot reach steamdeck at 192\.168\.77\.20:8765.*decky-toolkit pair/);
    return `${Date.now() - t0} ms`;
  } finally {
    setState({ hosts });
  }
});

await check('deploy', async () => {
  const before = state().installs.length;
  const r = await cli(['deploy', plugin]);
  assert.equal(r.code, 0, r.stderr);
  const inst = state().installs.slice(before);
  assert.equal(inst.length, 1);
  assert.equal(inst[0].dir, 'my-plugin', 'an installed plugin keeps its device dir');
  assert.equal(inst[0].restart, 'plugin');
  assert.ok(inst[0].names.includes('my-plugin/dist/index.js') && inst[0].names.includes('my-plugin/main.py'), inst[0].names.join());
  assert.ok(!inst[0].names.some(n => n.includes('/src/')), 'src/ stays behind');
  assert.match(r.stdout, /Deployed My Plugin 1\.2\.3 to 192\.168\.77\.20 as my-plugin .*reload confirmed/);
  assert.match(r.stdout, /Reload confirmed: loader imported My Plugin v1\.2\.3 /);
  // A debug-flagged plugin is left to the file watcher; the fake's never fires, so the deploy asks for a reload after 4 s.
  writeFileSync(path.join(plugin, 'plugin.json'), JSON.stringify({ name: 'My Plugin', flags: ['debug'] }));
  const reloads = state().reloads.length;
  const w = await cli(['deploy', plugin]);
  assert.equal(w.code, 0, w.stderr);
  assert.equal(state().installs.at(-1).restart, 'none');
  assert.deepEqual(state().reloads.slice(reloads), ['my-plugin']);
  assert.match(w.stdout, /waiting for the loader's file watcher/);
  assert.match(w.stdout, /asked Decky to reload it\nReload confirmed: loader imported My Plugin v1\.2\.3/);
  const fresh = path.join(scratch, 'fresh-plugin');
  mkdirSync(path.join(fresh, 'dist'), { recursive: true });
  writeFileSync(path.join(fresh, 'plugin.json'), JSON.stringify({ name: 'Fresh' }));
  writeFileSync(path.join(fresh, 'dist', 'index.js'), '');
  setState({ installMeta: { name: 'Fresh', version: '0.1.0' } });
  const n = await cli(['deploy', 'fresh-plugin']);
  assert.equal(n.code, 0, n.stderr);
  const last = state().installs.at(-1);
  assert.deepEqual([last.dir, last.restart], ['fresh-plugin', 'loader']);
  assert.match(n.stdout, /this first install restarts the loader\n.*\nInstalled Fresh 0\.1\.0 .*\nWaiting for the loader to restart\nDevice back: decky-toolkit 0\.2\.1\n/s);
  const missing = await cli(['deploy', path.join(scratch, 'nowhere')]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /no readable plugin\.json/);
});

await check('forget', async () => {
  const r = await cli(['forget']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Forgot the pairing with steamdeck .*remove it in the Decky Toolkit panel/);
  assert.equal(existsSync(identityPath), false);
  const again = await cli(['forget']);
  assert.equal(again.code, 0);
  assert.match(again.stdout, /nothing to forget/);
  const m = await mcp([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'screen_capture', arguments: {} } }]);
  assert.equal(m.replies.get(1).result.isError, true);
  assert.match(m.replies.get(1).result.content[0].text, /not paired.*decky-toolkit pair/);
});

await check('npm pack contents', async () => {
  const [packed] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  const names = packed.files.map(f => f.path).sort();
  assert.deepEqual(names, ['LICENSE', 'README.md', 'dist/cli.js', 'package.json']);
  return `${(statSync('dist/cli.js').size / 1024).toFixed(1)} KiB bundle, ${(packed.size / 1024).toFixed(1)} KiB packed`;
});

const failed = results.filter(r => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
