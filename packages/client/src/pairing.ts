import { createHash, generateKeyPairSync } from 'crypto';
import type { PairClientKind } from './api';
import { DeckyClient, HttpError, describeError, sleep } from './client';
import { Identity, PeerCert, fingerprint } from './transport';

/** Mutable so tests can shorten them. There is no overall timeout: pairing waits until approved, denied or cancelled. */
export const pairingTimings = { waitS: 25, retryMs: 2000 };

// `mismatch`: the device's code differs from ours, so something between us and the device altered the request.
export type PairOutcome = { identity: Identity } | 'cancelled' | 'denied' | 'unsupported' | 'mismatch' | { error: string };

export interface PairingOptions {
  clientName: string;
  clientKind?: PairClientKind;
  signal: AbortSignal;
  /** A request was filed and the device shows `code`. */
  onCode?(code: string): void;
  /** The device answered a poll; the request is still `code`. */
  onPoll?(code: string): void;
  /** A request or poll failed to reach the device; pairing retries. */
  onLostContact?(error: unknown, code: string | undefined): void;
}

/** The code the device shows, as both sides derive it from the device certificate, our public key and the request id. */
export function pairingCode(serverCertDer: Buffer, publicKeyDer: Buffer, id: string): string {
  const digest = createHash('sha256').update(serverCertDer).update(publicKeyDer).update(id, 'utf8').digest();
  return String(digest.readUInt32BE(0) % 10000).padStart(4, '0');
}

/**
 * Files a pairing request and long-polls it; a request the device forgot is filed again (new code).
 * The private key stays in memory until the device approves; only the public key is sent.
 */
export async function requestApproval(client: DeckyClient, opts: PairingOptions): Promise<PairOutcome> {
  const { signal } = opts;
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const publicKeyDer = keys.publicKey.export({ type: 'spki', format: 'der' });
  const pause = () => sleep(pairingTimings.retryMs, signal).catch(() => undefined);
  let id: string | undefined;
  let code: string | undefined;
  let serverCert: PeerCert | undefined;
  let mismatched = false;
  const mismatch = (): PairOutcome => { mismatched = true; return 'mismatch'; };
  try {
    while (!signal.aborted) {
      if (!id) {
        let created;
        try {
          created = await client.requestPairing(opts.clientName, publicKeyPem, opts.clientKind);
        } catch (e) {
          if (e instanceof HttpError) return { error: describeError(e) };
          opts.onLostContact?.(e, code);
          await pause();
          continue;
        }
        if (created === 'unsupported') return 'unsupported';
        id = created.created.id;
        serverCert = created.serverCert;
        code = pairingCode(serverCert.der, publicKeyDer, id);
        if (created.created.code !== code) return mismatch();
        opts.onCode?.(code);
      }
      let r;
      try {
        r = await client.pollPairing(id, pairingTimings.waitS, signal);
      } catch (e) {
        if (signal.aborted) break;
        opts.onLostContact?.(e, code);
        await pause();
        continue;
      }
      if (r === 'gone') {
        id = undefined;
        continue;
      }
      opts.onPoll?.(code!);
      if (r.status === 'denied') return 'denied';
      if (r.status === 'approved') {
        if (!r.client_cert || !r.server_cert) return { error: 'the device approved the request but already handed out its answer' };
        let sameDevice = false;
        try {
          sameDevice = fingerprint(r.server_cert) === serverCert!.fingerprint256;
        } catch {
          // not a parsable certificate
        }
        if (!sameDevice) return mismatch();
        return { identity: { key: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), cert: r.client_cert, serverCert: serverCert!.pem } };
      }
    }
    return 'cancelled';
  } finally {
    if ((signal.aborted || mismatched) && id) void client.cancelPairing(id).catch(() => undefined);
  }
}
