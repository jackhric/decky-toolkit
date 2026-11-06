import * as http from 'http';
import * as https from 'https';
import { X509Certificate, createHash } from 'crypto';
import type { PeerCertificate, TLSSocket } from 'tls';
import { Readable } from 'stream';

/** What pairing stores per device: our private key, the certificate the device issued for it, and the device's own certificate. */
export interface Identity {
  key: string;
  cert: string;
  serverCert: string;
}

export interface PeerCert {
  der: Buffer;
  pem: string;
  fingerprint256: string;
}

export type DeviceInit = RequestInit & { identity?: Identity };
/** `peerCert` is the certificate the device presented on this connection. */
export type DeviceResponse = Response & { peerCert?: PeerCert };

/** The device is not the one we paired with (it was reset or replaced), or it refused our identity. */
export class TrustError extends Error {
  constructor(cause?: unknown) {
    super('the device does not match its pairing; connect to it again to pair', { cause });
    this.name = 'TrustError';
  }
}

const TRUST_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
]);

function errorCode(e: unknown): string {
  const x = e as { code?: unknown; cause?: { code?: unknown } } | undefined;
  return String(x?.cause?.code ?? x?.code ?? '');
}

function isTrustFailure(e: unknown): boolean {
  if (e instanceof TrustError) return true;
  const code = errorCode(e);
  return TRUST_CODES.has(code) || code.startsWith('CERT_') || code.startsWith('ERR_TLS_')
    || /^ERR_SSL_.*(CERTIFICATE|UNKNOWN_CA)/.test(code);
}

/** An older plugin answers the handshake in plain HTTP. */
export function isPlainHttpDevice(e: unknown): boolean {
  const code = errorCode(e);
  return code === 'EPROTO' || code === 'ERR_SSL_WRONG_VERSION_NUMBER' || code === 'ERR_SSL_PACKET_LENGTH_TOO_LONG';
}

export function derToPem(der: Buffer): string {
  const b64 = der.toString('base64').match(/.{1,64}/g)!.join('\n');
  return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
}

/** `AA:BB:…` SHA-256 of the DER, the form Node reports for peer certificates. */
export function fingerprint(cert: string | Buffer): string {
  if (typeof cert === 'string') return new X509Certificate(cert).fingerprint256;
  return createHash('sha256').update(cert).digest('hex').toUpperCase().match(/../g)!.join(':');
}

/**
 * Paired: trust only the pinned device certificate and present ours. The custom identity check also
 * replaces hostname matching, which a device addressed by IP could never pass. Not paired (health,
 * pairing): accept any certificate; pairing reads it from the response to derive the code and pin it.
 */
export function tlsOptions(identity?: Identity): https.RequestOptions {
  if (!identity) return { rejectUnauthorized: false };
  const pinned = fingerprint(identity.serverCert);
  return {
    ca: [identity.serverCert],
    cert: identity.cert,
    key: identity.key,
    checkServerIdentity: (_host: string, c: PeerCertificate) => (c.fingerprint256 === pinned ? undefined : new TrustError()),
  };
}

/** A raw request to the device with the TLS options of `identity`, for the proxy's pass-through and WebSocket upgrade. */
export function deviceRequest(
  target: { host: string; port: number; identity?: Identity },
  options: https.RequestOptions,
): http.ClientRequest {
  return https.request({ ...options, ...tlsOptions(target.identity), host: target.host, port: target.port });
}

function peerCertOf(res: http.IncomingMessage): PeerCert | undefined {
  const c = (res.socket as TLSSocket | null)?.getPeerCertificate?.();
  if (!c?.raw) return undefined;
  return { der: c.raw, pem: derToPem(c.raw), fingerprint256: c.fingerprint256 };
}

const NULL_BODY = new Set([101, 103, 204, 205, 304]);

async function serializeBody(url: string, init: RequestInit, headers: Headers): Promise<Buffer | undefined> {
  const body = init.body;
  if (body == null) return undefined;
  if (typeof body === 'string') return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  // FormData, Blob, URLSearchParams: let the web Request encode it, multipart boundary included.
  const req = new Request(url, { method: init.method ?? 'POST', body });
  const type = req.headers.get('content-type');
  if (type && !headers.has('content-type')) headers.set('content-type', type);
  return Buffer.from(await req.arrayBuffer());
}

async function httpsFetch(url: string, init: DeviceInit = {}): Promise<DeviceResponse> {
  const u = new URL(url);
  const signal = init.signal ?? undefined;
  signal?.throwIfAborted();
  const headers = new Headers(init.headers);
  const body = await serializeBody(url, init, headers);
  if (body) headers.set('content-length', String(body.length));
  const method = (init.method ?? 'GET').toUpperCase();
  const outgoing: Record<string, string> = {};
  headers.forEach((v, k) => { outgoing[k] = v; });
  return new Promise<DeviceResponse>((resolve, reject) => {
    const req = https.request({
      ...tlsOptions(init.identity),
      host: u.hostname.replace(/^\[|\]$/g, ''),
      port: u.port || 443,
      path: u.pathname + u.search,
      method,
      headers: outgoing,
    });
    let res: http.IncomingMessage | undefined;
    const onAbort = () => {
      const reason = signal?.reason;
      req.destroy(reason);
      res?.destroy(reason);
      reject(reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    req.on('error', err => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(signal.reason);
      if (isTrustFailure(err)) return reject(err instanceof TrustError ? err : new TrustError(err));
      // Same shape as a failed `fetch`, which `isConnectionError` and `describeError` already read.
      reject(Object.assign(new TypeError('fetch failed'), { cause: err }));
    });
    req.on('response', incoming => {
      res = incoming;
      const out = new Headers();
      for (const [k, v] of Object.entries(incoming.headers)) {
        if (Array.isArray(v)) v.forEach(x => out.append(k, x));
        else if (v !== undefined) out.set(k, v);
      }
      const status = incoming.statusCode ?? 502;
      const empty = NULL_BODY.has(status) || method === 'HEAD';
      if (empty) incoming.resume();
      incoming.on('close', () => signal?.removeEventListener('abort', onAbort));
      const response: DeviceResponse = new Response(empty ? null : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>), {
        status, statusText: incoming.statusMessage, headers: out,
      });
      response.peerCert = peerCertOf(incoming);
      resolve(response);
    });
    req.end(body);
  });
}

/** Mutable so tests can stand in for the device. */
export const transportHooks = { fetch: httpsFetch };

/** `fetch` for device URLs (`https://<host>:<port>/…`); with `identity` the connection is pinned and authenticated. */
export function deviceFetch(url: string, init?: DeviceInit): Promise<DeviceResponse> {
  return transportHooks.fetch(url, init);
}

