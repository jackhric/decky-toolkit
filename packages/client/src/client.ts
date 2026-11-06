import type {
  AppsList,
  ControllersList,
  FsListing,
  GameDirs,
  GameSaves,
  Health,
  InputSettings,
  InstallResult,
  JsonRpcResponse,
  LiveReloadMode,
  LiveReloadResult,
  LogQuery,
  LogTail,
  NavigateRequest,
  NavigateResult,
  PairClientKind,
  PairPoll,
  PairRequestCreated,
  PluginInfo,
  ProtonLog,
  RestartMode,
  StreamSettings,
  StreamSettingsPatch,
  StreamStats,
  ToolCallResult,
  ToolDescription,
  ToolsListResult,
  UiRoutes,
  VirtualPadCreated,
  AppActionResult,
} from './api';
import { DeviceResponse, Identity, PeerCert, TrustError, deviceFetch, isPlainHttpDevice } from './transport';

export { TrustError } from './transport';

export interface DeviceAddress {
  host: string;
  port: number;
}

export class HttpError extends Error {
  constructor(public readonly status: number, public readonly body: string, path: string) {
    super(`${path}: HTTP ${status}${body ? ` ${summarize(body)}` : ''}`);
  }
}

/** The client API version this client speaks; every client route lives under `API_BASE`. */
export const API = 'v1';
export const API_BASE = `/api/${API}`;

/** Why this client cannot work with the device (it does not serve `API`), or undefined when it can. */
export function outdatedDevice(health: Health): string | undefined {
  return health.api?.includes(API)
    ? undefined
    : `the Decky Toolkit plugin on the device (${health.version}) is too old for this client; update it with Decky's Install Plugin from URL`;
}

function summarize(body: string): string {
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed.error === 'string') return parsed.error;
  } catch {
    // not JSON
  }
  return body.length > 200 ? body.slice(0, 200) + '…' : body;
}

/** The server's own `{"error"}` text, for messages that must show it as-is. */
export function serverError(e: unknown): string {
  if (e instanceof HttpError) {
    try {
      const parsed = JSON.parse(e.body);
      if (parsed && typeof parsed.error === 'string') return parsed.error;
    } catch {
      // not JSON
    }
  }
  return describeError(e);
}

export function isConnectionError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  if (e.name === 'TimeoutError') return true;
  const code = (e as { cause?: { code?: string } }).cause?.code ?? (e as { code?: string }).code;
  return (
    e.message === 'fetch failed' ||
    ['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'].includes(code ?? '')
  );
}

/** The device no longer accepts this editor: it forgot the pairing (401) or is not the device we paired with. */
export function isRejection(e: unknown): boolean {
  return e instanceof TrustError || (e instanceof HttpError && e.status === 401);
}

export function describeError(e: unknown): string {
  if (isPlainHttpDevice(e)) return 'the device runs an older Decky Toolkit; update it';
  if (isConnectionError(e)) {
    const cause = (e as { cause?: { message?: string } }).cause?.message;
    return `cannot reach the device${cause ? ` (${cause})` : ''}`;
  }
  return e instanceof Error ? e.message : String(e);
}

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }, { once: true });
  });

function withTimeout(ms: number, signal?: AbortSignal): AbortSignal {
  const t = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([t, signal]) : t;
}

function logQueryString(q: LogQuery): string {
  const p = new URLSearchParams();
  if (q.source) p.set('source', q.source);
  if (q.plugin) p.set('plugin', q.plugin);
  if (q.tail !== undefined) p.set('tail', String(q.tail));
  const s = p.toString();
  return s ? `?${s}` : '';
}

export class DeckyClient {
  private rpcId = 0;

  constructor(public readonly address: DeviceAddress, private readonly identity?: Identity) {}

  get baseUrl(): string {
    return `https://${this.address.host}:${this.address.port}`;
  }

  async fetch(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<DeviceResponse> {
    const { timeoutMs, ...rest } = init;
    return deviceFetch(this.baseUrl + path, {
      ...rest,
      identity: this.identity,
      signal: timeoutMs === 0 ? rest.signal : withTimeout(timeoutMs ?? 15000, rest.signal ?? undefined),
    });
  }

  /** A client API route: `path` is relative to `API_BASE`. */
  api(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<DeviceResponse> {
    return this.fetch(API_BASE + path, init);
  }

  private async json<T>(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
    const res = await this.api(path, init);
    const text = await res.text();
    if (!res.ok) throw new HttpError(res.status, text, path);
    return JSON.parse(text) as T;
  }

  private post<T>(path: string, body: unknown, timeoutMs = 15000): Promise<T> {
    return this.json<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), timeoutMs });
  }

  private put<T>(path: string, body: unknown, timeoutMs = 15000): Promise<T> {
    return this.json<T>(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), timeoutMs });
  }

  async health(timeoutMs = 5000): Promise<Health> {
    const res = await this.fetch('/health', { timeoutMs });
    const text = await res.text();
    if (!res.ok) throw new HttpError(res.status, text, '/health');
    return JSON.parse(text) as Health;
  }

  /**
   * Whether the device still accepts this client's pairing. `/health` needs none, so this asks a paired route.
   * Only a 401 or a device that is not the one we paired with is `rejected`; a plain-HTTP device is `unsupported`;
   * any other failure says nothing either way.
   */
  async acceptsIdentity(): Promise<'accepted' | 'rejected' | 'unsupported' | { unknown: unknown }> {
    try {
      const res = await this.api('/stream/stats', { timeoutMs: 5000 });
      await res.text();
      return res.status === 401 ? 'rejected' : 'accepted';
    } catch (e) {
      if (isRejection(e)) return 'rejected';
      if (isPlainHttpDevice(e)) return 'unsupported';
      return { unknown: e };
    }
  }

  /**
   * `unsupported` when the device predates this kind of pairing. `serverCert` is the certificate the
   * device presented while answering, which the pairing code is derived from.
   */
  async requestPairing(clientName: string, publicKey: string, clientKind: PairClientKind = 'vscode'):
    Promise<{ created: PairRequestCreated; serverCert: PeerCert } | 'unsupported'> {
    let res: DeviceResponse;
    try {
      res = await this.api('/pair/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_name: clientName, client_kind: clientKind, public_key: publicKey }),
        timeoutMs: 5000,
      });
    } catch (e) {
      if (isPlainHttpDevice(e)) return 'unsupported';
      throw e;
    }
    const text = await res.text();
    if (res.ok) {
      if (!res.peerCert) throw new Error('the device did not identify itself');
      return { created: JSON.parse(text) as PairRequestCreated, serverCert: res.peerCert };
    }
    // Older plugins: the auth middleware answers 401 before routing; very old ones may 404/405.
    if (res.status === 401 || res.status === 404 || res.status === 405) return 'unsupported';
    throw new HttpError(res.status, text, '/pair/request');
  }

  /** Long-polls one request; `gone` once the device forgot it (expired, or the plugin restarted). */
  async pollPairing(id: string, waitS = 25, signal?: AbortSignal): Promise<PairPoll | 'gone'> {
    const path = `/pair/request/${encodeURIComponent(id)}?wait=${waitS}`;
    const res = await this.api(path, { timeoutMs: (waitS + 10) * 1000, signal });
    const text = await res.text();
    if (res.status === 404) return 'gone';
    if (!res.ok) throw new HttpError(res.status, text, path);
    return JSON.parse(text) as PairPoll;
  }

  async cancelPairing(id: string): Promise<void> {
    await (await this.api(`/pair/request/${encodeURIComponent(id)}`, { method: 'DELETE', timeoutMs: 5000 })).text();
  }

  /** The device's JSON-RPC reply body as received, so a relay can pass it on without re-encoding it. */
  async rpcText(method: string, params: Record<string, unknown> | undefined, timeoutMs: number, id: string | number | null): Promise<string> {
    const res = await this.fetch('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      timeoutMs,
    });
    const text = await res.text();
    if (!res.ok) throw new HttpError(res.status, text, '/mcp');
    return text;
  }

  async rpc<T>(method: string, params?: Record<string, unknown>, timeoutMs = 30000): Promise<T> {
    const reply = JSON.parse(await this.rpcText(method, params, timeoutMs, ++this.rpcId)) as JsonRpcResponse<T>;
    if (reply.error) throw new Error(`${method}: ${reply.error.message}`);
    return reply.result as T;
  }

  async listTools(): Promise<ToolDescription[]> {
    return (await this.rpc<ToolsListResult>('tools/list')).tools;
  }

  callTool(name: string, args: Record<string, unknown> = {}, timeoutMs = 30000): Promise<ToolCallResult> {
    return this.rpc<ToolCallResult>('tools/call', { name, arguments: args }, timeoutMs);
  }

  streamStats(): Promise<StreamStats> {
    return this.json<StreamStats>('/stream/stats', { timeoutMs: 5000 });
  }

  /** Throws HttpError(404) on devices without capture. */
  getStreamSettings(): Promise<StreamSettings> {
    return this.json<StreamSettings>('/stream/settings', { timeoutMs: 5000 });
  }

  setStreamSettings(patch: StreamSettingsPatch): Promise<StreamSettings> {
    return this.put<StreamSettings>('/stream/settings', patch);
  }

  /** One JPEG of the whole display. */
  async frame(): Promise<Uint8Array> {
    const res = await this.api('/stream/frame', { timeoutMs: 10000 });
    if (!res.ok) throw new HttpError(res.status, await res.text(), '/stream/frame');
    return new Uint8Array(await res.arrayBuffer());
  }

  getInputSettings(): Promise<InputSettings> {
    return this.json<InputSettings>('/input/settings', { timeoutMs: 5000 });
  }

  setInputEnabled(enabled: boolean): Promise<InputSettings> {
    return this.put<InputSettings>('/input/settings', { enabled }, 10000);
  }

  listPlugins(): Promise<PluginInfo[]> {
    return this.json<PluginInfo[]>('/plugins');
  }

  installPlugin(zip: Uint8Array, filename: string, restart: RestartMode = 'loader'): Promise<InstallResult> {
    const form = new FormData();
    // Never backed by a SharedArrayBuffer here, which is all the cast rules out.
    form.append('file', new Blob([zip as Uint8Array<ArrayBuffer>], { type: 'application/zip' }), filename);
    return this.json<InstallResult>(`/plugins/install?restart=${restart}`, { method: 'POST', body: form, timeoutMs: 120000 });
  }

  /** Reload one plugin in place and restore the UI around it. Reloading Decky Toolkit's own backend only schedules it. */
  reloadPlugin(dir: string, mode: LiveReloadMode = 'backend'): Promise<LiveReloadResult> {
    return this.json<LiveReloadResult>(`/plugins/${encodeURIComponent(dir)}/reload?mode=${mode}`, { method: 'POST', timeoutMs: 30000 });
  }

  /** Atomically replace one file inside an installed plugin; `path` is relative to the plugin directory. */
  putPluginFile(dir: string, path: string, data: Uint8Array): Promise<{ dir: string; path: string; bytes: number }> {
    return this.json(`/plugins/${encodeURIComponent(dir)}/files?${new URLSearchParams({ path })}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(data),
      timeoutMs: 60000,
    });
  }

  restartLoader(): Promise<{ restarting: boolean; delay_s: number }> {
    return this.post('/loader/restart', {});
  }

  controllers(): Promise<ControllersList> {
    return this.json<ControllersList>('/controllers', { timeoutMs: 5000 });
  }

  /** The device refuses a fifth pad and pads Steam Input does not pick up. */
  addVirtualController(name?: string): Promise<VirtualPadCreated> {
    return this.post<VirtualPadCreated>('/controllers/virtual', name ? { name } : {}, 20000);
  }

  removeVirtualController(id: string): Promise<{ removed: string }> {
    return this.json(`/controllers/virtual/${encodeURIComponent(id)}`, { method: 'DELETE', timeoutMs: 10000 });
  }

  uiRoutes(): Promise<UiRoutes> {
    return this.json<UiRoutes>('/ui/routes', { timeoutMs: 10000 });
  }

  navigate(request: NavigateRequest): Promise<NavigateResult> {
    return this.post<NavigateResult>('/ui/navigate', request);
  }

  toast(title: string, body: string): Promise<unknown> {
    return this.post('/ui/toast', { title, body });
  }

  /** Runs `expression` in a Steam UI tab (default SharedJSContext) and returns its JSON value; promises are awaited. */
  async evaluate(expression: string): Promise<unknown> {
    return (await this.post<{ value: unknown }>('/cef/evaluate', { expression }, 30000)).value;
  }

  apps(): Promise<AppsList> {
    return this.json<AppsList>('/apps?installed_only=1', { timeoutMs: 30000 });
  }

  appDirs(appid: number): Promise<GameDirs> {
    return this.json<GameDirs>(`/apps/${appid}/dirs`, { timeoutMs: 30000 });
  }

  appSaves(appid: number): Promise<GameSaves> {
    return this.json<GameSaves>(`/apps/${appid}/saves`, { timeoutMs: 30000 });
  }

  protonLog(appid: number, lines = 1000): Promise<ProtonLog> {
    return this.json<ProtonLog>(`/apps/${appid}/proton-log?lines=${lines}`, { timeoutMs: 30000 });
  }

  launchApp(appid: number): Promise<AppActionResult> {
    return this.post<AppActionResult>(`/apps/${appid}/launch`, {}, 45000);
  }

  /** Force-quits the app; unsaved progress is lost, so callers confirm first. */
  terminateApp(appid: number): Promise<AppActionResult> {
    return this.post<AppActionResult>(`/apps/${appid}/terminate`, { confirm: true }, 45000);
  }

  fsList(path: string, glob?: string): Promise<FsListing> {
    const q = new URLSearchParams({ path });
    if (glob) q.set('glob', glob);
    return this.json<FsListing>(`/fs?${q}`, { timeoutMs: 20000 });
  }

  async fsRead(path: string): Promise<Uint8Array> {
    const route = `/fs/read?${new URLSearchParams({ path })}`;
    const res = await this.api(route, { timeoutMs: 120000 });
    if (!res.ok) throw new HttpError(res.status, await res.text(), route);
    return new Uint8Array(await res.arrayBuffer());
  }

  fsWrite(path: string, data: Uint8Array, opts: { create: boolean; overwrite: boolean }): Promise<{ path: string; bytes: number; created: boolean }> {
    const q = new URLSearchParams({ path, create: opts.create ? '1' : '0', overwrite: opts.overwrite ? '1' : '0' });
    return this.json(`/fs/write?${q}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(data),
      timeoutMs: 120000,
    });
  }

  fsMkdir(path: string): Promise<unknown> {
    return this.json('/fs/mkdir', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) });
  }

  fsRename(from: string, to: string, overwrite: boolean): Promise<unknown> {
    return this.json('/fs/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from, to, overwrite }) });
  }

  fsDelete(path: string): Promise<unknown> {
    return this.json(`/fs?${new URLSearchParams({ path, confirm: '1' })}`, { method: 'DELETE', timeoutMs: 60000 });
  }

  /** The last `tail` lines of the loader journal or of a plugin's newest log. */
  async logTail(q: LogQuery): Promise<string[]> {
    return (await this.json<LogTail>(`/logs/tail${logQueryString(q)}`)).lines;
  }

  /** Resolves when the stream ends; throws HttpError(404) on devices without `/logs/stream`. */
  async streamLogs(q: LogQuery, onLine: (line: string) => void, signal: AbortSignal): Promise<void> {
    const path = `/logs/stream${logQueryString(q)}`;
    const res = await this.api(path, { headers: { Accept: 'text/event-stream' }, signal, timeoutMs: 0 });
    if (!res.ok || !res.body) throw new HttpError(res.status, await res.text(), path);
    await parseSse(res.body, data => data.split('\n').forEach(onLine));
  }

  /**
   * Waits for the device to come back after a loader restart. The restart fires about 1 s after the
   * install reply, so an early healthy answer may still be the old process; require either having
   * seen it go down or a grace period before trusting it.
   */
  async waitForRestart(timeoutMs = 90000, signal?: AbortSignal): Promise<Health> {
    const start = Date.now();
    let seenDown = false;
    let last: unknown;
    while (Date.now() - start < timeoutMs) {
      try {
        const h = await this.health(3000);
        if (h.ok && (seenDown || Date.now() - start > 15000)) return h;
      } catch (e) {
        seenDown = true;
        last = e;
      }
      await sleep(1500, signal);
    }
    throw new Error(`device did not come back within ${timeoutMs / 1000} s (${describeError(last)})`);
  }
}

export async function parseSse(body: ReadableStream<Uint8Array>, onEvent: (data: string) => void): Promise<void> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let data: string[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      let line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line === '') {
        if (data.length) onEvent(data.join('\n'));
        data = [];
      } else if (line.startsWith('data:')) {
        data.push(line.slice(line[5] === ' ' ? 6 : 5));
      }
    }
  }
  if (data.length) onEvent(data.join('\n'));
}
