// Integration check against a live device, without VS Code.
// Usage: DECKY_TOKEN_FILE=/path/to/token node scripts/dev-check.mjs [host] [port]
import * as esbuild from 'esbuild';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const host = process.argv[2] ?? process.env.DECKY_HOST ?? '10.0.70.18';
const port = Number(process.argv[3] ?? process.env.DECKY_PORT ?? 8765);
const tokenFile = process.env.DECKY_TOKEN_FILE;
if (!tokenFile) {
  console.error('Set DECKY_TOKEN_FILE to a file containing the bearer token.');
  process.exit(2);
}
const token = readFileSync(tokenFile, 'utf8').trim();

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
const redact = s => String(s).split(token).join('<token>');

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

const proxy = new DeviceProxy(() => ({ host, port, token }));
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
  if (parts < 100) throw new Error(`only ${parts} parts in 5 s (${mbps} Mbit/s, ${ctype})`);
  return `${parts} parts in 5 s (${(parts / 5).toFixed(1)} fps, ${mbps} Mbit/s, ${ctype})`;
});

await check('MCP tools/list via client', async () => {
  const tools = await new DeckyClient({ host, port }, token).listTools();
  if (tools.length < 13) throw new Error(`only ${tools.length} tools`);
  return `${tools.length} tools: ${tools.map(t => t.name).join(', ')}`;
});

await check('MCP tools/call loader_log via client', async () => {
  const text = await new DeckyClient({ host, port }, token).callToolText('loader_log', { lines: 5 });
  return `${text.split('\n').length} lines`;
});

await check('planned routes probe (informational)', async () => {
  const c = new DeckyClient({ host, port }, token);
  const probe = async (p, init) => (await c.fetch(p, { timeoutMs: 5000, ...init }).then(r => { r.body?.cancel(); return r.status; }));
  const pair = await new DeckyClient({ host, port }).pair();
  const stream = await probe('/logs/stream?tail=1', { headers: { Accept: 'text/event-stream' } });
  return `/pair → ${typeof pair === 'string' ? pair : 'granted'}, /logs/stream → ${stream}, /logs/tail → ${await probe('/logs/tail?tail=1')}, /plugins → ${await probe('/plugins')}`;
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

proxy.stop();
const failed = results.filter(r => !r[0]);
console.log(failed.length ? `\n${failed.length} check(s) failed` : '\nall checks passed');
process.exit(failed.length ? 1 : 0);
