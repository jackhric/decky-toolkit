import * as vscode from 'vscode';
import type { FsEntry } from './api';
import { DeckyClient, DeviceAddress, HttpError, describeError, isConnectionError, isMissingRoute } from './client';
import type { SavedDevice } from './connection';

export const SCHEME = 'decky';
const DEFAULT_PORT = 8765;
const LISTING_TTL_MS = 2000;
// Resolving a symlink costs a request; Proton prefixes hold hundreds (system32), so only the first few are.
const MAX_SYMLINK_LOOKUPS = 64;

export interface DeviceSource {
  readonly devices: SavedDevice[];
  tokenFor(address: DeviceAddress): Promise<string | undefined>;
}

export function deviceAuthority(d: DeviceAddress): string {
  return d.port === DEFAULT_PORT ? d.host : `${d.host}:${d.port}`;
}

/** `decky://<host[:port]>/<absolute path>` */
export function deckyUri(d: DeviceAddress, path: string): vscode.Uri {
  return vscode.Uri.from({ scheme: SCHEME, authority: deviceAuthority(d), path });
}

/** fnmatch pattern that matches exactly `name`. */
export function globEscape(name: string): string {
  return name.replace(/[[*?]/g, c => `[${c}]`);
}

function parentOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i <= 0 ? '/' : path.slice(0, i);
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function errorCode(e: HttpError): string | undefined {
  try {
    return JSON.parse(e.body)?.code;
  } catch {
    return undefined;
  }
}

function serverMessage(e: HttpError): string {
  try {
    const m = JSON.parse(e.body)?.error;
    if (typeof m === 'string') return m;
  } catch {
    // plain text
  }
  return e.message;
}

/** Maps a failed device call to the FileSystemError VS Code expects. */
export function toFsError(e: unknown, uri: vscode.Uri, device: string): Error {
  if (e instanceof vscode.FileSystemError) return e;
  if (isConnectionError(e)) return vscode.FileSystemError.Unavailable(`Decky device ${device} is not reachable (${describeError(e)})`);
  if (!(e instanceof HttpError)) return new vscode.FileSystemError(describeError(e));
  if (isMissingRoute(e)) return vscode.FileSystemError.Unavailable(`the Decky Toolkit plugin on ${device} has no remote file access yet; update it`);
  const code = errorCode(e);
  if (e.status === 401) return vscode.FileSystemError.NoPermissions(`${device} rejected the token; re-pair it in the Decky view`);
  if (e.status === 403) return vscode.FileSystemError.NoPermissions(serverMessage(e));
  if (e.status === 404) return vscode.FileSystemError.FileNotFound(uri);
  if (code === 'EEXIST') return vscode.FileSystemError.FileExists(uri);
  if (code === 'EISDIR') return vscode.FileSystemError.FileIsADirectory(uri);
  if (code === 'ENOTDIR') return vscode.FileSystemError.FileNotADirectory(uri);
  return new vscode.FileSystemError(serverMessage(e));
}

function typeOf(e: FsEntry): vscode.FileType {
  if (e.type === 'dir') return vscode.FileType.Directory;
  if (e.type === 'file') return vscode.FileType.File;
  if (e.type === 'symlink') return vscode.FileType.SymbolicLink | vscode.FileType.File;
  return vscode.FileType.Unknown;
}

function toStat(e: FsEntry, type = typeOf(e)): vscode.FileStat {
  const t = e.mtime ? Date.parse(e.mtime) : 0;
  return { type, size: e.size, mtime: t, ctime: t };
}

/** The device file system at `decky://<host>/<path>`, backed by the `/fs` routes of the Decky Toolkit server. */
export class DeckyFileSystemProvider implements vscode.FileSystemProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changed.event;
  private readonly listings = new Map<string, { at: number; entries: FsEntry[]; truncated: boolean }>();

  constructor(private readonly source: DeviceSource) {}

  private device(uri: vscode.Uri): SavedDevice {
    const [host, port] = uri.authority.split(':');
    const want = { host, port: port ? Number(port) : DEFAULT_PORT };
    const d = this.source.devices.find(x => x.host === want.host && x.port === want.port);
    if (!d) throw vscode.FileSystemError.Unavailable(`no saved Decky device ${uri.authority}; add it in the Decky view`);
    return d;
  }

  private async call<T>(uri: vscode.Uri, fn: (client: DeckyClient) => Promise<T>): Promise<T> {
    const d = this.device(uri);
    const token = await this.source.tokenFor(d);
    if (!token) throw vscode.FileSystemError.Unavailable(`not paired with Decky device ${d.name}; connect to it in the Decky view`);
    try {
      return await fn(new DeckyClient(d, token));
    } catch (e) {
      throw toFsError(e, uri, d.name);
    }
  }

  private key(uri: vscode.Uri, path = uri.path): string {
    return `${uri.authority}${path}`;
  }

  private forget(): void {
    this.listings.clear();
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const path = uri.path;
    if (path === '/' || path === '') return { type: vscode.FileType.Directory, size: 0, mtime: 0, ctime: 0 };
    const name = baseName(path);
    const cached = this.listings.get(this.key(uri, parentOf(path)));
    let entry: FsEntry | undefined;
    if (cached && Date.now() - cached.at < LISTING_TTL_MS && !cached.truncated) {
      entry = cached.entries.find(e => e.path === name);
      if (!entry) throw vscode.FileSystemError.FileNotFound(uri);
    } else {
      const listing = await this.call(uri, c => c.fsList(parentOf(path), globEscape(name)));
      entry = listing.entries.find(e => e.path === name);
    }
    if (!entry) throw vscode.FileSystemError.FileNotFound(uri);
    if (entry.type === 'symlink') return toStat(entry, vscode.FileType.SymbolicLink | await this.linkTarget(uri, path));
    return toStat(entry);
  }

  private async linkTarget(uri: vscode.Uri, path: string): Promise<vscode.FileType> {
    try {
      await this.call(uri, c => c.fsList(path, '\0'));
      return vscode.FileType.Directory;
    } catch {
      return vscode.FileType.File;
    }
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const listing = await this.call(uri, c => c.fsList(uri.path));
    this.listings.set(this.key(uri), { at: Date.now(), entries: listing.entries, truncated: listing.truncated });
    const links = listing.entries.filter(e => e.type === 'symlink').slice(0, MAX_SYMLINK_LOOKUPS);
    const resolved = new Map<string, vscode.FileType>();
    for (let i = 0; i < links.length; i += 8) {
      await Promise.all(links.slice(i, i + 8).map(async e => {
        const full = `${uri.path.replace(/\/$/, '')}/${e.path}`;
        resolved.set(e.path, vscode.FileType.SymbolicLink | await this.linkTarget(uri, full));
      }));
    }
    return listing.entries.map(e => [e.path, resolved.get(e.path) ?? typeOf(e)]);
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    return this.call(uri, c => c.fsRead(uri.path));
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean }): Promise<void> {
    const res = await this.call(uri, c => c.fsWrite(uri.path, content, options));
    this.forget();
    this.changed.fire([{ type: res.created ? vscode.FileChangeType.Created : vscode.FileChangeType.Changed, uri }]);
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    await this.call(uri, c => c.fsMkdir(uri.path));
    this.forget();
    this.changed.fire([{ type: vscode.FileChangeType.Created, uri }]);
  }

  async delete(uri: vscode.Uri): Promise<void> {
    await this.call(uri, c => c.fsDelete(uri.path));
    this.forget();
    this.changed.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
  }

  async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
    if (oldUri.authority !== newUri.authority) throw vscode.FileSystemError.NoPermissions('cannot move files between Decky devices');
    await this.call(oldUri, c => c.fsRename(oldUri.path, newUri.path, options.overwrite));
    this.forget();
    this.changed.fire([{ type: vscode.FileChangeType.Deleted, uri: oldUri }, { type: vscode.FileChangeType.Created, uri: newUri }]);
  }

  dispose(): void {
    this.changed.dispose();
  }
}
