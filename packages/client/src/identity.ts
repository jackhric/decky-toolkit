import { promises as fs, mkdirSync, watch as watchDir, type FSWatcher } from 'fs';
import { randomBytes } from 'crypto';
import { homedir } from 'os';
import * as path from 'path';
import type { Identity } from './transport';

/** The device this machine is paired with; one per machine, shared by the extension and the CLI. */
export interface IdentityDevice {
  host: string;
  port: number;
  name: string;
  deviceId?: string;
}

export interface IdentityFile extends Identity {
  version: 1;
  device: IdentityDevice;
}

const FILE = 'identity.json';

/** Mutable so tests can shorten it. */
export const identityTimings = { debounceMs: 100, rewatchMs: 1000 };

/** `DECKY_TOOLKIT_CONFIG_DIR` replaces the whole directory; it exists for tests only. */
export function configDir(): string {
  const override = process.env.DECKY_TOOLKIT_CONFIG_DIR;
  if (override) return override;
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(homedir(), 'AppData', 'Roaming'), 'decky-toolkit');
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  return path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(homedir(), '.config'), 'decky-toolkit');
}

export function identityPath(): string {
  return path.join(configDir(), FILE);
}

/** Null for anything but a valid version 1 file; a newer version is left for the newer client. */
export function parseIdentity(raw: string): IdentityFile | null {
  try {
    const x = JSON.parse(raw) as Partial<IdentityFile> | null;
    const d = x?.device;
    if (x?.version !== 1 || !d || typeof d.host !== 'string' || typeof d.port !== 'number' || typeof d.name !== 'string') return null;
    if (d.deviceId !== undefined && typeof d.deviceId !== 'string') return null;
    if (typeof x.key !== 'string' || typeof x.cert !== 'string' || typeof x.serverCert !== 'string') return null;
    const device: IdentityDevice = { host: d.host, port: d.port, name: d.name, ...(d.deviceId ? { deviceId: d.deviceId } : {}) };
    return { version: 1, device, key: x.key, cert: x.cert, serverCert: x.serverCert };
  } catch {
    return null;
  }
}

export async function read(): Promise<IdentityFile | null> {
  try {
    return parseIdentity(await fs.readFile(identityPath(), 'utf8'));
  } catch {
    return null;
  }
}

/** True when a file exists, valid or not (a newer client's file must not be overwritten by a migration). */
export async function exists(): Promise<boolean> {
  return fs.stat(identityPath()).then(() => true, () => false);
}

async function ensureDir(): Promise<string> {
  const dir = configDir();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700).catch(() => undefined);
  return dir;
}

/** Written to a temp file and renamed over the old one, so readers never see a partial file. */
export async function write(identity: IdentityFile): Promise<void> {
  const dir = await ensureDir();
  const tmp = path.join(dir, `.${FILE}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    await fs.writeFile(tmp, JSON.stringify(identity, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await fs.rename(tmp, path.join(dir, FILE));
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}

export async function remove(): Promise<void> {
  await fs.rm(identityPath(), { force: true });
}

export function sameDevice(a: { host: string; port: number }, b: { host: string; port: number }): boolean {
  return a.host === b.host && a.port === b.port;
}

export function toIdentity(f: IdentityFile): Identity {
  return { key: f.key, cert: f.cert, serverCert: f.serverCert };
}

/**
 * Calls `cb` with the file's new value (null when it is gone or invalid) after it changes. Watches the
 * directory, so the rename of `write` and writes by other processes are seen; the watch is set up again
 * if the directory goes away.
 */
export function watch(cb: (identity: IdentityFile | null) => void): { close(): void } {
  let watcher: FSWatcher | undefined;
  let debounce: NodeJS.Timeout | undefined;
  let rewatch: NodeJS.Timeout | undefined;
  let closed = false;
  const changed = () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => void read().then(v => { if (!closed) cb(v); }), identityTimings.debounceMs);
  };
  const start = () => {
    if (closed) return;
    try {
      const dir = configDir();
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      watcher = watchDir(dir, (_event, name) => {
        if (!name || name.toString() === FILE) changed();
      });
      watcher.on('error', () => {
        watcher?.close();
        watcher = undefined;
        changed();
        rewatch = setTimeout(start, identityTimings.rewatchMs);
      });
    } catch {
      rewatch = setTimeout(start, identityTimings.rewatchMs);
    }
  };
  start();
  return {
    close: () => {
      closed = true;
      clearTimeout(debounce);
      clearTimeout(rewatch);
      watcher?.close();
    },
  };
}
