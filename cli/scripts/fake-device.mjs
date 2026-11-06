// A stand-in device for the CLI smoke test, installed through the shared client's transport and discovery hooks
// (the same seams the extension smoke uses). Bundled into the harness next to the CLI; its state lives in
// $FAKE_DEVICE/state.json so the smoke test can script it and read back what the CLI did.
import { X509Certificate, createHash, createPublicKey } from 'crypto';
import { readFileSync, writeFileSync } from 'fs';
import * as path from 'path';

const stateFile = () => path.join(process.env.FAKE_DEVICE, 'state.json');
const load = () => JSON.parse(readFileSync(stateFile(), 'utf8'));
const save = s => writeFileSync(stateFile(), JSON.stringify(s, null, 2));

let hooks;
const refused = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' } });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function peerOf(pem) {
  const x = new X509Certificate(pem);
  return { der: x.raw, pem, fingerprint256: x.fingerprint256 };
}

function deviceCode(serverDer, publicKeyPem, id) {
  const spki = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  const d = createHash('sha256').update(serverDer).update(spki).update(id, 'utf8').digest();
  return String(d.readUInt32BE(0) % 10000).padStart(4, '0');
}

async function deviceFetch(url, init = {}) {
  const s = load();
  const u = new URL(url);
  if (!s.hosts.includes(u.hostname)) throw refused();
  if (s.downFor > 0 && u.pathname === '/health') {
    s.downFor--;
    save(s);
    throw refused();
  }
  const server = peerOf(s.serverCert);
  if (init.identity && init.identity.serverCert !== s.serverCert) {
    throw new hooks.TrustError();
  }
  const authed = init.identity?.cert === s.clientCert;
  s.requests.push(`${init.method ?? 'GET'} ${u.pathname}`);
  const done = res => { save(s); return res; };

  if (u.pathname === '/health') return done(json(s.health));
  if (u.pathname === '/pair/request' && init.method === 'POST') {
    const body = JSON.parse(init.body);
    const id = `req${s.pairRequests.length}`;
    const code = deviceCode(server.der, body.public_key, id);
    s.pairRequests.push({ id, code, client_name: body.client_name, client_kind: body.client_kind });
    return done(Object.assign(json({ id, code, poll_after_ms: 1000 }, 201), { peerCert: server }));
  }
  const pairReq = /^\/pair\/request\/([^/]+)$/.exec(u.pathname);
  if (pairReq && init.method === 'DELETE') {
    s.pairCancelled.push(pairReq[1]);
    return done(json({ cancelled: true }));
  }
  if (pairReq) {
    const next = s.pairQueue.shift() ?? 'pending';
    save(s);
    if (next === 'approved') return json({ status: 'approved', client_cert: s.clientCert, server_cert: s.serverCert, api_version: 2 });
    // A long poll that holds until the CLI gives up (Ctrl-C aborts the signal).
    if (next === 'pending' && !s.pairQueue.length) {
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, 200);
        init.signal?.addEventListener('abort', () => { clearTimeout(t); reject(init.signal.reason); }, { once: true });
      });
    }
    return json({ status: next });
  }
  if (!authed) return done(new Response('unauthorized', { status: 401 }));
  if (u.pathname === '/stream/stats') return done(json({ available: true, running: false, subscribers: 0, fps: 0 }));
  if (u.pathname === '/plugins') return done(json(s.plugins));
  if (u.pathname === '/plugins/install' && init.method === 'POST') {
    const file = init.body.get('file');
    const bytes = Buffer.from(await file.arrayBuffer());
    const dir = file.name.replace(/\.zip$/, '');
    const restart = u.searchParams.get('restart');
    // Every entry name of the zip, read from the central directory.
    const names = [];
    for (let i = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])), off = bytes.readUInt32LE(i + 16), n = bytes.readUInt16LE(i + 10); n > 0; n--) {
      const len = bytes.readUInt16LE(off + 28);
      names.push(bytes.subarray(off + 46, off + 46 + len).toString());
      off += 46 + len + bytes.readUInt16LE(off + 30) + bytes.readUInt16LE(off + 32);
    }
    s.installs.push({ dir, restart, bytes: bytes.length, names });
    s.plugins = [...s.plugins.filter(p => p.dir !== dir), { dir, name: s.installMeta.name, version: s.installMeta.version, flags: [] }];
    if (restart === 'loader') s.downFor = 1;
    if (restart === 'plugin') s.journal.push(`[loader][INFO]: Loaded ${s.installMeta.name} (v${s.installMeta.version}) #${s.installs.length}`);
    return done(json({ installed: { dir, name: s.installMeta.name, version: s.installMeta.version }, restarted: restart }));
  }
  const files = /^\/plugins\/([^/]+)\/files$/.exec(u.pathname);
  if (files && init.method === 'PUT') {
    const dir = decodeURIComponent(files[1]), rel = u.searchParams.get('path');
    s.filePuts = [...(s.filePuts ?? []), { dir, path: rel, text: Buffer.from(init.body).toString() }];
    return done(json({ dir, path: rel, bytes: init.body.length }));
  }
  const reload = /^\/plugins\/([^/]+)\/reload$/.exec(u.pathname);
  if (reload && init.method === 'POST' && u.searchParams.get('mode')) {
    const dir = decodeURIComponent(reload[1]), mode = u.searchParams.get('mode');
    s.liveReloads = [...(s.liveReloads ?? []), { dir, mode }];
    return done(json({ dir, name: s.installMeta.name, mode, load_ms: 9, reloaded: true, restored: ['panel'], routes: [],
      errors: mode === 'frontend' ? ['Error: boom\n    at http://127.0.0.1:1337/plugins/My%20Plugin/dist/index.js?t=1:1:1'] : [] }));
  }
  if (reload && init.method === 'POST') {
    const dir = decodeURIComponent(reload[1]);
    const p = s.plugins.find(x => x.dir === dir);
    s.reloads.push(dir);
    s.journal.push(`[loader][INFO]: Loaded ${p?.name ?? dir} (v${p?.version}) reload`);
    return done(json({ reloaded: dir }));
  }
  if (u.pathname === '/logs/tail' && u.searchParams.get('source') === 'loader') return done(json({ lines: s.journal.slice(-Number(u.searchParams.get('tail'))) }));
  if (u.pathname === '/mcp' && init.method === 'POST') {
    const { id, method, params } = JSON.parse(init.body);
    s.rpc.push(method === 'tools/call' ? `tools/call ${params.name}` : method);
    if (method === 'tools/list') return done(json({ jsonrpc: '2.0', id, result: { tools: s.tools } }));
    if (method !== 'tools/call') return done(json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } }));
    if (params.name === 'decky_status') return done(json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({ loader: 'v3.3.1', args: params.arguments }) }], isError: false } }));
    if (params.name === 'screen_capture') {
      return done(json({ jsonrpc: '2.0', id, result: { content: [{ type: 'image', data: s.frameB64, mimeType: 'image/jpeg' }, { type: 'text', text: '1920x1080' }], isError: false } }));
    }
    return done(json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Unknown tool: ${params.name}` }], isError: true } }));
  }
  return done(new Response('404: Not Found', { status: 404 }));
}

export function installFake(h) {
  hooks = h;
  const { transportHooks, discoveryHooks, discoveryTimings, pairingTimings } = h;
  transportHooks.fetch = deviceFetch;
  pairingTimings.retryMs = 50;
  discoveryTimings.mdnsMs = 100;
  discoveryTimings.probeTimeoutMs = 100;
  discoveryHooks.interfaces = () => ({
    lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1', netmask: '255.0.0.0' }],
    eth0: [{ family: 'IPv4', internal: false, address: '192.168.77.10', netmask: '255.255.255.0' }],
  });
  discoveryHooks.fetch = async url => {
    const s = load();
    const u = new URL(url);
    if (!s.discoverable.includes(u.host)) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'EHOSTUNREACH' } });
    return json(s.health);
  };
  discoveryHooks.createSocket = () => ({
    bind: (_port, cb) => setTimeout(cb, 0),
    on: () => undefined,
    setMulticastInterface: () => undefined,
    setMulticastTTL: () => undefined,
    send: (_msg, _port, _addr, cb) => setTimeout(() => cb(null), 0),
    close: () => undefined,
  });
}
