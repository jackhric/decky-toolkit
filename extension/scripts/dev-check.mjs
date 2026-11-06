// Integration check against a live device, without VS Code.
// Usage: DECKY_IDENTITY_FILE=/path/to/identity.json node scripts/dev-check.mjs [host] [port]
import * as esbuild from 'esbuild';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const host = process.argv[2] ?? process.env.DECKY_HOST;
const port = Number(process.argv[3] ?? process.env.DECKY_PORT ?? 8765);
const identityFile = process.env.DECKY_IDENTITY_FILE;
if (!identityFile || !host) {
  console.error('Usage: DECKY_IDENTITY_FILE=<file> node scripts/dev-check.mjs <host> [port]  (or set DECKY_HOST)');
  process.exit(2);
}
// The JSON the extension keeps in secret storage under decky-toolkit.identity:<host:port>: {key, cert, serverCert}.
const identity = JSON.parse(readFileSync(identityFile, 'utf8'));

const outfile = path.join(root, 'out', 'devlib.cjs');
await esbuild.build({
  stdin: {
    contents: "export * from './src/proxy'; export * from './src/client'; export * from './src/stage';",
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile,
  logLevel: 'warning',
});
const { DeviceProxy, DeckyClient, isConnectionError, stagePlugin, parseSse } = createRequire(import.meta.url)(outfile);

const results = [];
const redact = s => String(s).split(identity.key).join('<key>');

async function check(name, fn) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const detail = await fn();
      results.push([true, name, detail]);
      console.log(`PASS  ${name}: ${detail}`);
      return;
    } catch (e) {
      const conn = isConnectionError(e) || /ECONNREFUSED|ECONNRESET|502/.test(String(e?.message));
      if (attempt === 1 && conn) {
        console.log(`....  ${name}: connection error (${redact(e.message)}); retrying in 30 s`);
        await new Promise(r => setTimeout(r, 30000));
        continue;
      }
      results.push([false, name, redact(e.message)]);
      console.log(`FAIL  ${name}: ${redact(e.message)}`);
      return;
    }
  }
}

const proxy = new DeviceProxy(() => ({ host, port, identity }), new Map(), () => 0);
const base = await proxy.start();
console.log(`proxy listening on ${new URL(base).origin}/<secret>, device ${host}:${port}`);

await check('proxy rejects unknown prefix', async () => {
  const res = await fetch(new URL(base).origin + '/health');
  if (res.status !== 404) throw new Error(`expected 404, got ${res.status}`);
  return '404 without the secret prefix';
});

await check('/health via proxy', async () => {
  const res = await fetch(base + '/health', { headers: { Origin: 'vscode-webview://dev-check' } });
  const body = await res.json();
  if (!res.ok || body.ok !== true) throw new Error(`HTTP ${res.status} ${JSON.stringify(body)}`);
  const cors = res.headers.get('access-control-allow-origin');
  if (cors !== 'vscode-webview://dev-check') throw new Error(`missing CORS header (${cors})`);
  return `ok=true ${body.name} ${body.version} api_version=${body.api_version} tools=${body.tools}`;
});

await check('authenticated route via proxy with foreign Origin', async () => {
  const res = await fetch(base + '/stream/stats', { headers: { Origin: 'vscode-webview://dev-check' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
  const s = await res.json();
  return `stream/stats available=${s.available} running=${s.running} fps=${s.fps}`;
});

await check('/stream.mjpeg via proxy (5 s)', async () => {
  const ac = new AbortController();
  const res = await fetch(base + '/stream.mjpeg', { signal: ac.signal, headers: { Origin: 'vscode-webview://dev-check' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
  const ctype = res.headers.get('content-type');
  const reader = res.body.getReader();
  const deadline = Date.now() + 5000;
  setTimeout(() => ac.abort(), 5000);
  let parts = 0, bytes = 0, tail = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.length;
      // Count part headers; keep a small tail so a header split across chunks is not missed.
      const text = tail + Buffer.from(value).toString('latin1');
      parts += (text.match(/content-length:/gi) ?? []).length;
      tail = text.slice(-32).replace(/content-length:/gi, '');
      if (Date.now() > deadline) break;
    }
  } catch (e) {
    if (e.name !== 'AbortError') throw e;
  }
  const mbps = (bytes * 8 / 5 / 1e6).toFixed(1);
  // The stream fps is configurable on the device; expect two thirds of its cap (100 parts at 30 fps).
  const cap = (await new DeckyClient({ host, port }, identity).streamStats()).settings?.fps || 30;
  const min = Math.floor(cap * 5 * 2 / 3);
  if (parts < min) throw new Error(`only ${parts} parts in 5 s, expected ${min} at the ${cap} fps cap (${mbps} Mbit/s, ${ctype})`);
  return `${parts} parts in 5 s (${(parts / 5).toFixed(1)} fps, cap ${cap}, min ${min}, ${mbps} Mbit/s, ${ctype})`;
});

await check('/plugins via proxy and client', async () => {
  const res = await fetch(base + '/plugins', { headers: { Origin: 'vscode-webview://dev-check' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
  const viaProxy = await res.json();
  const viaClient = await new DeckyClient({ host, port }, identity).listPlugins();
  if (!Array.isArray(viaProxy) || viaProxy.length !== viaClient.length) throw new Error(`proxy ${viaProxy.length} vs client ${viaClient.length}`);
  const bad = viaClient.find(p => typeof p.dir !== 'string');
  if (bad) throw new Error(`entry without dir: ${JSON.stringify(bad)}`);
  return viaClient.map(p => `${p.name ?? p.dir} ${p.version ?? '?'} (${p.dir}, backend=${p.has_backend})`).join('; ');
});

await check('/frame.jpg via proxy (sidebar preview)', async () => {
  const sizes = [];
  for (let i = 0; i < 3; i++) {
    const res = await fetch(`${base}/frame.jpg?t=${Date.now()}`, { headers: { Origin: 'vscode-webview://dev-check' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
    if (res.headers.get('access-control-allow-origin') !== 'vscode-webview://dev-check') throw new Error('missing CORS header');
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error(`not a JPEG (${res.headers.get('content-type')})`);
    sizes.push(buf.length);
    await new Promise(r => setTimeout(r, 1500));
  }
  return `3 frames at 1.5 s: ${sizes.map(s => `${(s / 1024).toFixed(0)} KiB`).join(', ')} (≈${(sizes.reduce((a, b) => a + b) * 8 / 4.5 / 1e6).toFixed(2)} Mbit/s)`;
});

await check('/frame.jpg via client (Snapshot to file)', async () => {
  const jpeg = await new DeckyClient({ host, port }, identity).frame();
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg.at(-2) !== 0xff || jpeg.at(-1) !== 0xd9) throw new Error('not a complete JPEG');
  return `${(jpeg.length / 1024).toFixed(0)} KiB JPEG`;
});

// Runs the real media/screen.js against the proxy in a minimal DOM, including the repeated
// `visible: true` messages VS Code sends on focus changes, and compares its fps readout with the
// device's own /stream/stats and with a raw part count.
await check('screen panel fps readout matches the device', async () => {
  const src = readFileSync(path.join(root, 'media', 'screen.js'), 'utf8');
  const els = new Map();
  const el = id => {
    if (!els.has(id)) {
      const classes = new Set();
      const e = {
        textContent: '', hidden: false, onclick: null, onload: null, addEventListener() {},
        classList: { add: c => classes.add(c), remove: c => classes.delete(c), toggle: (c, on) => ((on ?? !classes.has(c)) ? classes.add(c) : classes.delete(c), classes.has(c)) },
      };
      Object.defineProperty(e, 'src', { set(v) { this._src = v; queueMicrotask(() => this.onload?.()); }, get() { return this._src; } });
      e.naturalWidth = 1920; e.naturalHeight = 1080;
      els.set(id, e);
    }
    return els.get(id);
  };
  const listeners = [];
  const document = { getElementById: el, body: { dataset: { base } }, addEventListener() {} };
  const window = { addEventListener: (t, fn) => { if (t === 'message') listeners.push(fn); } };
  const post = data => listeners.forEach(fn => fn({ data }));
  new Function('acquireVsCodeApi', 'document', 'window', src)(() => ({ postMessage() {} }), document, window);
  for (const t of [800, 1600, 2400]) setTimeout(() => post({ type: 'visible', visible: true }), t);
  await new Promise(r => setTimeout(r, 6000));
  const shown = Number(el('fps').textContent);
  const frames = Number(el('frames').textContent);
  post({ type: 'visible', visible: false });
  const s = await new DeckyClient({ host, port }, identity).streamStats();
  const ref = s.settings?.fps ? Math.min(s.fps, s.settings.fps) : s.fps;
  const diff = Math.abs(shown - ref) / ref;
  if (!(diff <= 0.1)) throw new Error(`page shows ${shown} fps, device reports ${s.fps} (cap ${s.settings?.fps}); ${frames} frames in 6 s`);
  return `page shows ${shown} fps after 3 extra "visible" messages, device reports ${s.fps} fps (cap ${s.settings?.fps}), ${frames} frames in 6 s (${(frames / 6).toFixed(1)}/s)`;
});

// Reads the device's input flag but never changes it: input must stay off on the shared device.
await check('/input WebSocket through the proxy upgrades and is closed with 4003 while input is off', async () => {
  const st = await new DeckyClient({ host, port }, identity).getInputSettings();
  if (st.enabled) throw new Error('input is enabled on the device; this check needs it off and does not change it');
  const wsUrl = base.replace(/^http/, 'ws') + '/input';
  const outcome = url => new Promise(resolve => {
    const ws = new WebSocket(url);
    let opened = false;
    const t = setTimeout(() => { ws.close(); resolve({ timeout: true, opened }); }, 10000);
    ws.onopen = () => { opened = true; };
    // Node's WebSocket fires only `error`, no `close`, when the handshake is refused.
    ws.onerror = () => { if (!opened) { clearTimeout(t); resolve({ refused: true, opened }); } };
    ws.onclose = e => { clearTimeout(t); resolve({ code: e.code, reason: e.reason, opened }); };
  });
  const r = await outcome(wsUrl);
  if (r.code !== 4003) throw new Error(`expected close 4003, got ${JSON.stringify(r)}`);
  const bad = await outcome(wsUrl.replace(new URL(base).pathname, ''));
  if (!bad.refused) throw new Error(`socket without the secret prefix was not refused: ${JSON.stringify(bad)}`);
  return `GET /input/settings enabled=false backend=${st.backend} available=${st.available}; ws ${r.opened ? 'opened (101)' : 'not opened'}, ` +
    `closed ${r.code} "${r.reason}"; without the prefix the handshake is refused`;
});

// Reads the device's audio flag but never changes it.
await check('/audio WebSocket through the proxy: format frame and >= 10 PCM chunks in 1 s', async () => {
  const st = await new DeckyClient({ host, port }, identity).getStreamSettings();
  if (st.audio === undefined) throw new Error('device predates audio streaming (no "audio" in /stream/settings)');
  if (!st.audio) throw new Error('audio is off on the device; this check needs it on and does not change it');
  const ws = new WebSocket(base.replace(/^http/, 'ws') + '/audio');
  ws.binaryType = 'arraybuffer';
  const r = await new Promise((resolve, reject) => {
    let format = null, chunks = 0, bytes = 0, first = 0;
    const t = setTimeout(() => { ws.close(); reject(new Error(`timeout: format=${JSON.stringify(format)} chunks=${chunks}`)); }, 10000);
    ws.onerror = () => { clearTimeout(t); reject(new Error('handshake refused')); };
    ws.onclose = e => { clearTimeout(t); reject(new Error(`closed ${e.code} ${e.reason} after ${chunks} chunks`)); };
    ws.onmessage = ev => {
      if (typeof ev.data === 'string') { format = JSON.parse(ev.data); return; }
      if (!format) { clearTimeout(t); reject(new Error('binary before the format frame')); return; }
      if (!first) first = Date.now();
      chunks++; bytes += ev.data.byteLength;
      // The pipeline may still be starting for the first chunk; time the second second only.
      if (Date.now() - first >= 1000) {
        clearTimeout(t); ws.onclose = null; ws.close();
        resolve({ format, chunks, bytes });
      }
    };
  });
  const f = r.format;
  if (f.type !== 'format' || f.codec !== 'pcm_s16le' || f.rate !== 48000 || f.channels !== 2) throw new Error(`unexpected format ${JSON.stringify(f)}`);
  if (r.chunks < 10) throw new Error(`only ${r.chunks} chunks in 1 s`);
  return `format ${f.codec} ${f.rate} Hz ${f.channels} ch ${f.chunk_ms} ms; ${r.chunks} chunks (${(r.bytes * 8 / 1000).toFixed(0)} kbit) in 1 s`;
});

await check('MCP tools/list via client', async () => {
  const tools = await new DeckyClient({ host, port }, identity).listTools();
  if (tools.length < 13) throw new Error(`only ${tools.length} tools`);
  return `${tools.length} tools: ${tools.map(t => t.name).join(', ')}`;
});

await check('MCP tools/call loader_log via client', async () => {
  const text = await new DeckyClient({ host, port }, identity).callToolText('loader_log', { lines: 5 });
  return `${text.split('\n').length} lines`;
});

// Read-only: never adds pads or navigates on the shared device. Passes on 404 (older device).
await check('controllers and Steam UI routes probe (informational)', async () => {
  const c = new DeckyClient({ host, port }, identity);
  const parts = [];
  try {
    const l = await c.controllers();
    const rows = l.controllers.map(x => `${x.name} [${x.kind}, Steam Input: ${x.steam ? `${x.steam.type} slot ${x.steam.slot}` : 'not seen'}]`);
    parts.push(`/controllers: ${rows.join(', ') || 'none'}; ${l.virtual.length} virtual (${l.virtual.map(v => `${v.name}${v.auto ? ' auto' : ''}`).join(', ')}); input_enabled=${l.input_enabled}`);
  } catch (e) {
    parts.push(`/controllers → ${redact(e.message)}`);
  }
  try {
    const r = await c.uiRoutes();
    parts.push(`/ui/routes: current ${r.current}, ${r.official.length} official, ${r.plugins.length} plugin routes, tabs ${r.quick_access_tabs.join('/') || 'none'}`);
  } catch (e) {
    parts.push(`/ui/routes → ${redact(e.message)}`);
  }
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 5000);
  try {
    const res = await fetch(base + '/controllers/events', { signal: ac.signal, headers: { Accept: 'text/event-stream', Origin: 'vscode-webview://dev-check' } });
    parts.push(`/controllers/events via proxy → ${res.status} ${res.headers.get('content-type') ?? ''}`.trim());
    ac.abort();
  } catch (e) {
    parts.push(`/controllers/events via proxy → ${e.name === 'AbortError' ? 'no headers in 5 s' : redact(e.message)}`);
  } finally {
    clearTimeout(t);
  }
  return parts.join('; ');
});

await check('planned routes probe (informational)', async () => {
  const c = new DeckyClient({ host, port }, identity);
  const probe = async (p, init) => (await c.fetch(p, { timeoutMs: 5000, ...init }).then(r => { r.body?.cancel(); return r.status; }));
  // Probes without filing a request, so nothing shows up under the device's Pairing requests.
  const pair = await new DeckyClient({ host, port }).pollPairing('dev-check-unknown', 0);
  const stream = await probe('/logs/stream?tail=1', { headers: { Accept: 'text/event-stream' } });
  return `/pair/request/<unknown> → ${typeof pair === 'string' ? pair : pair.status}, /pair/requests → ${await probe('/pair/requests')}, /logs/stream → ${stream}, /logs/tail → ${await probe('/logs/tail?tail=1')}, /plugins → ${await probe('/plugins')}`;
});

await check('SSE parser', async () => {
  const chunks = ['data: one\n\n: keepalive\n\nda', 'ta: two\r\n\r\ndata: a\ndata: b\n\n'];
  const body = new ReadableStream({ start(c) { chunks.forEach(s => c.enqueue(new TextEncoder().encode(s))); c.close(); } });
  const got = [];
  await parseSse(body, d => got.push(d));
  if (JSON.stringify(got) !== JSON.stringify(['one', 'two', 'a\nb'])) throw new Error(JSON.stringify(got));
  return got.length + ' events';
});

await check('stage + zip a sample plugin', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'decky-stage-'));
  const put = (rel, text, mode = 0o644) => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text, { mode });
  };
  const big = 'export default 1;\n'.repeat(50);
  put('plugin.json', JSON.stringify({ name: 'Sample', author: 'x', flags: [], api_version: 1 }));
  put('package.json', '{"version":"1.0.0"}');
  put('main.py', 'class Plugin: pass\n');
  put('dist/index.js', big);
  put('py_modules/pkg/__init__.py', '');
  put('py_modules/pkg/__pycache__/x.pyc', 'junk');
  put('bin/tool', '#!/bin/sh\necho hi\n', 0o755);
  put('src/index.tsx', 'not shipped');
  const { zip, files } = await stagePlugin(dir, 'sample-plugin');
  const file = path.join(dir, 'p.zip');
  writeFileSync(file, zip);
  execFileSync('unzip', ['-tq', file]);
  const listing = execFileSync('unzip', ['-Z1', file]).toString().trim().split('\n');
  const tops = new Set(listing.map(l => l.split('/')[0]));
  if (tops.size !== 1 || !tops.has('sample-plugin')) throw new Error(`top-level dirs: ${[...tops]}`);
  if (listing.some(l => l.includes('__pycache__') || l.includes('/src/'))) throw new Error(`unexpected entries: ${listing}`);
  const out = path.join(dir, 'x');
  execFileSync('unzip', ['-q', file, '-d', out]);
  if (!(statSync(path.join(out, 'sample-plugin/bin/tool')).mode & 0o100)) throw new Error('bin/tool lost its exec bit');
  if (readFileSync(path.join(out, 'sample-plugin/dist/index.js'), 'utf8') !== big) throw new Error('content mismatch');
  return `${listing.length} entries, unzip -t ok, exec bit kept (${files.join(' ')})`;
});

// Informational: game file routes. Printed, never counted as failures (older devices lack them).
async function info(name, fn) {
  try {
    console.log(`INFO  ${name}: ${await fn()}`);
  } catch (e) {
    console.log(`INFO  ${name}: unavailable (${redact(e.message)})`);
  }
}
const devClient = new DeckyClient({ host, port }, identity);
await info('/fs?path=/home/jackh/.local/share/VVVVVV', async () => {
  const l = await devClient.fsList('/home/jackh/.local/share/VVVVVV');
  return `${l.count} entries (${l.entries.map(e => `${e.path}${e.type === 'dir' ? '/' : ''}`).join(', ')})`;
});
await info('/apps/70300/saves', async () => {
  const s = await devClient.appSaves(70300);
  const best = s.candidates[0];
  return `${s.candidates.length} candidates, ${s.steam_cloud.length} Steam Cloud files; best ${best ? `${best.path} (${best.size} B, ${best.found_by})` : 'none'}`;
});
await info('/fs/read of the best VVVVVV save (read only)', async () => {
  const best = (await devClient.appSaves(70300)).candidates[0];
  if (!best) return 'no save to read';
  const bytes = await devClient.fsRead(best.path);
  return `${bytes.length} bytes${bytes.length === best.size ? ', matches the listed size' : `, listed ${best.size}`}`;
});

proxy.stop();
const failed = results.filter(r => !r[0]);
console.log(failed.length ? `\n${failed.length} check(s) failed` : '\nall checks passed');
process.exit(failed.length ? 1 : 0);
