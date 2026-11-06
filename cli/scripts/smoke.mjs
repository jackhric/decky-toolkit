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
import * as vm from 'vm';
import { options, toolsOptions } from '../esbuild.mjs';

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
const health = { ok: true, name: 'decky-toolkit', version: '0.2.1', api: ['v1'], tools: 2, hostname: 'steamdeck.local', device_id: 'dev-1', os: 'SteamOS' };
const stateFile = path.join(fakeDir, 'state.json');
const state = () => JSON.parse(readFileSync(stateFile, 'utf8'));
const setState = patch => writeFileSync(stateFile, JSON.stringify({ ...state(), ...patch }, null, 2));
writeFileSync(stateFile, JSON.stringify({
  hosts: ['192.168.77.20', '127.0.0.1'], discoverable: ['192.168.77.20:8765'], health, downFor: 0,
  serverCert: readFileSync(path.join(certDir, 'server.crt'), 'utf8'), clientCert: readFileSync(path.join(certDir, 'client.crt'), 'utf8'),
  journal: ['boot'], pairQueue: [], pairRequests: [], pairCancelled: [], requests: [], rpc: [], installs: [], reloads: [],
  plugins: [{ dir: 'my-plugin', name: 'My Plugin', version: '1.0.0', flags: [] }], installMeta: { name: 'My Plugin', version: '1.2.3' },
  tools: [
    { name: 'device_info', description: 'Loader status', inputSchema: { type: 'object', properties: {} } },
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
  const c = await cli(['call', 'device_info']);
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
  assert.match(r.stdout, /Plugin\s+decky-toolkit 0\.2\.1, api v1, 2 tools/);
  assert.match(r.stdout, /Paired\s+yes/);
  const j = JSON.parse((await cli(['status', '--json'])).stdout);
  assert.equal(j.paired, true);
  assert.equal(j.reachable, true);
  assert.deepEqual(j.plugin.api, ['v1']);
});

await check('call', async () => {
  const t = await cli(['call', 'device_info', '{"verbose":true}']);
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
  // `| head`: the reader goes away before the output is written.
  const cut = await cli(['call', 'big'], { onSpawn: child => child.stdout.destroy() });
  assert.deepEqual([cut.code, cut.stderr], [0, ''], 'EPIPE on stdout ends the command quietly');
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

await check('dev: deploy, then push changed files and reload in place until Ctrl-C', async () => {
  const { api: _api, ...oldHealth } = health;
  setState({ health: oldHealth });
  const old = await cli(['dev', '--no-build', plugin]);
  assert.equal(old.code, 1);
  assert.match(old.stderr, /The Decky Toolkit plugin on the device \(0\.2\.1\) is too old for this client; update it with Decky's Install Plugin from URL, then run dev again/);
  const installsBefore = state().installs.length;
  const oldDeploy = await cli(['deploy', plugin]);
  assert.equal(oldDeploy.code, 1);
  assert.match(oldDeploy.stderr, /Deploy failed: the Decky Toolkit plugin on the device \(0\.2\.1\) is too old for this client/);
  assert.equal(state().installs.length, installsBefore, 'nothing is uploaded to a device without the client API');
  setState({ health, filePuts: [], liveReloads: [], installMeta: { name: 'My Plugin', version: '1.2.3' } });
  writeFileSync(path.join(plugin, 'dist', 'index.js.map'), JSON.stringify({ version: 3, sources: ['../src/index.tsx'], mappings: 'AAAA' }));
  const installs = state().installs.length;
  let edited = false, stopped = false;
  const r = await cli(['dev', '--no-build', plugin], {
    timeoutMs: 30000,
    onStdout: (stdout, child) => {
      if (!edited && stdout.includes('Edit away')) {
        edited = true;
        writeFileSync(path.join(plugin, 'dist', 'index.js'), 'export default () => ({ name: "changed" });\n');
      }
      if (!stopped && /frontend reload of My Plugin/.test(stdout)) {
        stopped = true;
        setTimeout(() => child.kill('SIGINT'), 200);
      }
    },
  });
  setState({ health });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(state().installs.length, installs + 1, 'one full deploy at the start');
  assert.deepEqual(state().filePuts.map(f => f.path), ['dist/index.js']);
  assert.match(state().filePuts[0].text, /changed/);
  assert.deepEqual(state().liveReloads, [{ dir: 'my-plugin', mode: 'frontend' }]);
  assert.match(r.stdout, /frontend reload of My Plugin: dist\/index\.js, push \d+ ms, reload \d+ ms .*restored panel/);
  assert.match(r.stdout, /Error: boom\n {4}at src\/index\.tsx:1:1/, 'bundle positions mapped to the source');
  return r.stdout.split('\n').find(l => l.startsWith('frontend reload'));
});

await check('mcp over stdio', async () => {
  const t0 = Date.now();
  const r = await mcp([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'device_info', arguments: { a: 1 } } },
    { jsonrpc: '2.0', id: 'four', method: 'tools/call', params: { name: 'screen_capture', arguments: {} } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'device_status', arguments: {} } },
    { jsonrpc: '2.0', id: 6, method: 'resources/list' },
    '{not json',
    { jsonrpc: '2.0', id: 7, method: 'ping' },
    { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'plugin_deploy', arguments: { dir: plugin, restart: 'none' } } },
    '[{"jsonrpc":"2.0","id":9,"method":"ping"}]',
    { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'plugin_deploy', arguments: { restart: 'sometimes' } } },
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
  assert.deepEqual(init.capabilities, { tools: { listChanged: true } });
  assert.match(init.instructions, /plugin_deploy .* Device says hi\.$/, 'the device\'s own instructions, from its initialize');
  assert.deepEqual(r.replies.get(2).result.tools.map(t => t.name), ['device_info', 'screen_capture', 'plugin_deploy', 'device_status']);
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

await check('mcp: unknown arguments are refused; a changed device tool list sends tools/list_changed', async () => {
  setState({ health: { ...health, tools_hash: 'aaaa' } });
  const send = (child, m) => child.stdin.write(JSON.stringify(m) + '\n');
  let step = 0;
  const r = await cli(['mcp'], {
    timeoutMs: 30000,
    onSpawn: child => send(child, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } } }),
    onStdout: (stdout, child) => {
      const lines = stdout.split('\n').slice(0, -1).map(l => JSON.parse(l));
      if (step === 0 && lines.some(m => m.id === 1)) { step = 1; send(child, { jsonrpc: '2.0', id: 2, method: 'tools/list' }); }
      if (step === 1 && lines.some(m => m.id === 2)) {
        step = 2;
        setState({ health: { ...health, tools_hash: 'bbbb' } });
        send(child, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'device_info', arguments: {} } });
      }
      if (step === 2 && lines.some(m => m.method === 'notifications/tools/list_changed')) {
        step = 3;
        send(child, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'plugin_deploy', arguments: { path: plugin } } });
      }
      if (step === 3 && lines.some(m => m.id === 4)) { step = 4; child.stdin.end(); }
    },
  });
  setState({ health });
  assert.equal(r.code, 0, r.stderr);
  const msgs = r.stdout.trim().split('\n').map(l => JSON.parse(l));
  const note = msgs.findIndex(m => m.method === 'notifications/tools/list_changed');
  assert.ok(note > msgs.findIndex(m => m.id === 2), 'the notification follows the list it invalidates');
  assert.equal(msgs.filter(m => m.method === 'notifications/tools/list_changed').length, 1);
  const refused = msgs.find(m => m.id === 4).result;
  assert.equal(refused.isError, true);
  assert.equal(refused.content[0].text, "Invalid arguments for plugin_deploy: unknown argument 'path'. Arguments: dir (string); restart (none|plugin|loader).");
  return 'list_changed after the fingerprint moved; plugin_deploy {path} refused with the argument list';
});

await check('initialize answers without the device', async () => {
  const hosts = state().hosts;
  setState({ hosts: [] });
  try {
    const t0 = Date.now();
    const r = await mcp([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'device_info', arguments: {} } },
    ]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.replies.get(1).result.protocolVersion, '2025-11-25');
    assert.deepEqual(r.replies.get(2).result.tools.map(t => t.name), ['plugin_deploy', 'device_status']);
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

await check('tools helper', async () => {
  // Evaluated under a Decky bundle URL, as Decky imports a plugin, so the helper finds its plugin in the stack.
  const { outputFiles: [out] } = await esbuild.build({ ...toolsOptions, format: 'iife', globalName: 'tools', write: false, logLevel: 'warning' });
  const url = 'http://127.0.0.1:1337/plugins/My%20Plugin/dist/index.js?t=1';
  const { registerTool } = vm.runInThisContext(`${out.text};tools`, { filename: url });
  const { z } = await import('zod');
  let notified = 0;
  globalThis.__deckyToolkitToolsChanged = () => notified++;
  const ac = new AbortController();
  await registerTool({
    name: 'add', description: 'Adds.', annotations: { readOnlyHint: true },
    inputSchema: z.object({ a: z.number(), b: z.number().default(1) }),
    outputSchema: z.object({ sum: z.number() }),
    execute: ({ a, b }) => ({ sum: a + b }),
  }, { signal: ac.signal });
  await registerTool({ name: 'boom', description: 'Throws.', execute: () => { throw new Error('nope'); } });
  const tools = globalThis.__deckyToolkitTools.tools;
  const [add, boom] = tools;
  assert.deepEqual([add.plugin, add.url, add.annotations], ['My Plugin', url, { readOnlyHint: true }]);
  assert.deepEqual([add.inputSchema.type, add.inputSchema.required, add.outputSchema.required], ['object', ['a'], ['sum']]);
  assert.deepEqual(boom.inputSchema, { type: 'object', properties: {}, additionalProperties: false });
  assert.deepEqual(await add.call({ a: 2 }, ac.signal), { value: { sum: 3 } });
  assert.deepEqual(await add.call({ a: 'x' }, ac.signal), { invalid: 'a: Invalid input: expected number, received string' });
  await assert.rejects(boom.call({}, ac.signal), /nope/);
  await assert.rejects(registerTool({ name: 'add', description: 'Again.', execute: () => 0 }), /already registered/);
  await assert.rejects(registerTool({ name: 'Add', description: 'Bad name.', execute: () => 0 }), /invalid tool name/);
  await assert.rejects(registerTool({ name: 'x', description: 'Not an object.', inputSchema: z.string(), execute: () => 0 }),
    /inputSchema must describe an object/);
  assert.equal(notified, 2);
  ac.abort();
  assert.deepEqual([[...tools].map(t => t.name), notified], [['boom'], 3]);
  delete globalThis.__deckyToolkitTools;
  delete globalThis.__deckyToolkitToolsChanged;
});

await check('npm pack contents', async () => {
  const [packed] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  const names = packed.files.map(f => f.path).sort();
  assert.deepEqual(names, ['LICENSE', 'README.md', 'dist/cli.js', 'dist/tools.d.ts', 'dist/tools.js', 'package.json']);
  return `${(statSync('dist/cli.js').size / 1024).toFixed(1)} KiB bundle, ${(packed.size / 1024).toFixed(1)} KiB packed`;
});

const failed = results.filter(r => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
