import assert from 'assert/strict';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import {
  check, clientFp, clientKeys, ext, health, otherPki, pairedIdentity, realDeviceFetch, serverPeer, serverPki, settle,
  tlsLog, tlsPort, tlsUrl, withRealTransport,
} from './harness.mjs';

await check('transport: paired requests pin the device and present the client certificate; bodies and headers round-trip', async () => {
  tlsLog.length = 0;
  const res = await realDeviceFetch(tlsUrl('/x?q=1'), { identity: pairedIdentity, method: 'POST', body: 'hello', headers: { 'Content-Type': 'text/plain' } });
  assert.ok(res instanceof Response);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, path: '/x?q=1' });
  assert.equal(res.headers.get('set-cookie'), 'a=1, b=2');
  assert.equal(tlsLog[0].client, clientFp, 'the server saw our client certificate');
  assert.equal(tlsLog[0].authorized, true, 'signed by the device');
  assert.equal(tlsLog[0].body.toString(), 'hello');
  assert.equal(tlsLog[0].headers.authorization, undefined, 'no bearer header');
  await (await realDeviceFetch(tlsUrl('/bin'), { identity: pairedIdentity, method: 'PUT', body: new Uint8Array([1, 2, 3]) })).text();
  assert.deepEqual([...tlsLog[1].body], [1, 2, 3]);
  assert.equal(tlsLog[1].headers['content-length'], '3');
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array([9, 8, 7])], { type: 'application/zip' }), 'p.zip');
  await (await realDeviceFetch(tlsUrl('/form'), { identity: pairedIdentity, method: 'POST', body: form })).text();
  assert.match(tlsLog[2].headers['content-type'], /^multipart\/form-data; boundary=/);
  assert.match(tlsLog[2].body.toString('latin1'), /filename="p\.zip"\r\nContent-Type: application\/zip\r\n\r\n\x09\x08\x07\r\n/);
  const empty = await realDeviceFetch(tlsUrl('/empty'), { identity: pairedIdentity });
  assert.equal(empty.status, 204);
  assert.equal(await empty.text(), '');
  const client = new ext.DeckyClient({ host: '127.0.0.1', port: tlsPort }, pairedIdentity);
  assert.equal((await withRealTransport(() => client.health())).path, '/health', 'DeckyClient goes through it');
  return `client cert ${clientFp.slice(0, 11)}… seen; string, bytes, multipart, 204`;
});

await check('transport: a device whose certificate does not match the pin fails with TrustError', async () => {
  const wrong = await realDeviceFetch(tlsUrl('/x'), { identity: { ...pairedIdentity, serverCert: otherPki.cert } }).catch(e => e);
  assert.ok(wrong instanceof ext.TrustError, `got ${wrong}`);
  assert.equal(wrong.cause?.code, 'DEPTH_ZERO_SELF_SIGNED_CERT');
  // Same chain, different fingerprint: the pin check itself.
  const pin = ext.tlsOptions(pairedIdentity).checkServerIdentity;
  assert.ok(pin('10.1.2.3', { fingerprint256: 'AA:BB' }) instanceof ext.TrustError);
  assert.equal(pin('10.1.2.3', { fingerprint256: serverPeer.fingerprint256 }), undefined, 'an IP address is fine: the pin replaces hostname checks');
  const viaClient = new ext.DeckyClient({ host: '127.0.0.1', port: tlsPort }, { ...pairedIdentity, serverCert: otherPki.cert });
  assert.ok((await withRealTransport(() => viaClient.streamStats().catch(x => x))) instanceof ext.TrustError);
  return `${wrong.name}: ${wrong.message}`;
});

await check('transport: unpaired requests accept any certificate and expose it for the pairing code', async () => {
  tlsLog.length = 0;
  const res = await realDeviceFetch(tlsUrl('/health'));
  assert.equal(res.status, 200);
  await res.text();
  assert.equal(res.peerCert.fingerprint256, serverPeer.fingerprint256);
  assert.deepEqual(res.peerCert.der, serverPeer.der);
  assert.equal(res.peerCert.pem.replace(/\s/g, ''), serverPki.cert.replace(/\s/g, ''), 'PEM rebuilt from DER');
  assert.equal(ext.fingerprint(res.peerCert.der), serverPeer.fingerprint256);
  assert.equal(ext.fingerprint(res.peerCert.pem), serverPeer.fingerprint256);
  assert.equal(tlsLog[0].client, undefined, 'no client certificate before pairing');
  return res.peerCert.fingerprint256.slice(0, 11) + '…';
});

await check('transport: SSE bodies stream before the response ends; abort tears the request down', async () => {
  tlsLog.length = 0;
  const ac = new AbortController();
  const res = await realDeviceFetch(tlsUrl('/sse'), { identity: pairedIdentity, signal: ac.signal });
  const reader = res.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.equal(first, 'data: one\n\n', 'first event arrives while the stream is open');
  await reader.read();
  ac.abort();
  const after = await reader.read().catch(e => e);
  assert.ok(after instanceof Error && after.name === 'AbortError', `body read after abort: ${after?.name ?? JSON.stringify(after)}`);
  for (let i = 0; i < 50 && !tlsLog.some(l => l.closed); i++) await settle(10);
  assert.ok(tlsLog.some(l => l.closed === '/sse'), 'the server saw the connection close');
  const early = new AbortController();
  const pending = realDeviceFetch(tlsUrl('/slow'), { identity: pairedIdentity, signal: early.signal });
  setTimeout(() => early.abort(), 30);
  assert.equal((await pending.catch(x => x)).name, 'AbortError', 'abort before the response rejects like fetch');
  const timedOut = await realDeviceFetch(tlsUrl('/slow'), { identity: pairedIdentity, signal: AbortSignal.timeout(30) }).catch(x => x);
  assert.equal(timedOut.name, 'TimeoutError');
  const pre = await realDeviceFetch(tlsUrl('/x'), { signal: AbortSignal.abort() }).catch(x => x);
  assert.equal(pre.name, 'AbortError');
  return 'event before end, AbortError mid-body and before the answer, TimeoutError';
});

await check('transport: an older plugin answering in plain HTTP is "unsupported", not unreachable', async () => {
  const plain = http.createServer((_q, r) => r.end('{"ok":true}'));
  await new Promise(r => plain.listen(0, '127.0.0.1', r));
  const port = plain.address().port;
  try {
    const e = await realDeviceFetch(`https://127.0.0.1:${port}/health`).catch(x => x);
    assert.ok(ext.isPlainHttpDevice(e), `${e?.cause?.code}`);
    const client = new ext.DeckyClient({ host: '127.0.0.1', port });
    const pem = clientKeys.publicKey.export({ type: 'spki', format: 'pem' });
    assert.equal(await withRealTransport(() => client.requestPairing('x', pem)), 'unsupported');
    const refused = await realDeviceFetch('https://127.0.0.1:1/health').catch(x => x);
    assert.equal(refused.cause?.code, 'ECONNREFUSED', 'connection errors keep the fetch shape');
    assert.equal(refused.message, 'fetch failed');
  } finally {
    plain.close();
  }
  return 'EPROTO → unsupported; ECONNREFUSED → fetch failed';
});

await check('proxy: stable port (next free when taken), persisted prefix, HTTPS upstream with the pairing, WebSocket', async () => {
  const blocker = http.createServer();
  await new Promise(r => blocker.listen(0, '127.0.0.1', r));
  const taken = blocker.address().port;
  const state = new Map();
  const memento = { get: k => state.get(k), update: async (k, v) => { state.set(k, v); } };
  const target = { host: '127.0.0.1', port: tlsPort, identity: pairedIdentity };
  const proxy = new ext.DeviceProxy(() => target, memento, () => taken);
  const wrong = new ext.DeviceProxy(() => ({ ...target, identity: { ...pairedIdentity, serverCert: otherPki.cert } }), memento, () => 0);
  try {
    const base = await proxy.start();
    const secret = state.get('decky-toolkit.proxySecret');
    assert.ok(secret && secret.length >= 20);
    assert.equal(base, `http://127.0.0.1:${taken + 1}/${secret}`, 'next port after the taken one');
    assert.equal(await proxy.mcpUrl(), `${base}/mcp`);
    assert.equal(await proxy.rebase(`http://127.0.0.1:${taken + 7}/${secret}/mcp`), `${base}/mcp`);
    assert.equal(await proxy.rebase(`http://localhost:${taken + 7}/${secret}/mcp`), `${base}/mcp`);
    assert.equal(await proxy.rebase(`${base}/mcp`), undefined, 'already right');
    assert.equal(await proxy.rebase(`http://127.0.0.1:${taken + 7}/other/mcp`), undefined, 'not ours');
    assert.equal(await proxy.rebase('https://10.1.2.3:8765/mcp'), undefined);

    tlsLog.length = 0;
    const res = await new Promise((resolve, reject) => {
      const q = http.request(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer x' } }, resolve);
      q.on('error', reject);
      q.end('{"jsonrpc":"2.0"}');
    });
    let text = '';
    for await (const c of res) text += c;
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(text), { ok: true, path: '/mcp' });
    assert.equal(tlsLog[0].client, clientFp, 'upstream presents the client certificate');
    assert.equal(tlsLog[0].headers.authorization, undefined, 'no authorization header upstream');
    assert.equal(tlsLog[0].body.toString(), '{"jsonrpc":"2.0"}');

    const echoed = await new Promise((resolve, reject) => {
      const q = http.request(`${base}/input`, { headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': 'x', 'sec-websocket-version': '13' } });
      q.on('upgrade', (r, sock) => { sock.write('ping'); sock.once('data', d => { sock.destroy(); resolve([r.statusCode, d.toString()]); }); });
      q.on('error', reject);
      q.end();
    });
    assert.deepEqual(echoed, [101, 'echo:ping']);
    assert.equal(tlsLog.find(l => l.upgrade)?.client, clientFp, 'the WebSocket upgrade presents it too');

    const wrongBase = await wrong.start();
    assert.equal(wrongBase.split('/').pop(), secret, 'the prefix survives a restart');
    const bad = await new Promise((resolve, reject) => http.get(`${wrongBase}/health`, resolve).on('error', reject));
    bad.resume();
    assert.equal(bad.statusCode, 502, 'a device that does not match the pin is not reached');
  } finally {
    proxy.stop();
    wrong.stop();
    blocker.close();
  }
  return `taken ${taken} → ${taken + 1}`;
});
