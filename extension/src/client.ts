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
  LogQuery,
  LogTail,
  NavigateRequest,
  NavigateResult,
  PairClientKind,
  PairPoll,
  PairRequestCreated,
  PluginInfo,
  RestartMode,
  StreamStats,
  ToolCallResult,
  ToolDescription,
  ToolsListResult,
  UiRoutes,
  VirtualPadCreated,
} from './api';

export interface DeviceAddress {
  host: string;
  port: number;
}

export class HttpError extends Error {
  constructor(public readonly status: number, public readonly body: string, path: string) {
    super(`${path}: HTTP ${status}${body ? ` ${summarize(body)}` : ''}`);
  }
}

export class ToolError extends Error {}

function summarize(body: string): string {
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed.error === 'string') return parsed.error;
  } catch {
    // not JSON
  }
  return body.length > 200 ? body.slice(0, 200) + '…' : body;
}

/**
 * True when the device predates a planned route. aiohttp answers unknown paths with a plain-text
 * 404 (or 405 for a known path with another method), while the new routes reply with JSON errors.
 */
export function isMissingRoute(e: unknown): boolean {
  if (!(e instanceof HttpError) || (e.status !== 404 && e.status !== 405)) return false;
  try {
    return typeof JSON.parse(e.body)?.error !== 'string';
  } catch {
    return true;
  }
}

/** For GET/POST routes where 404 has no meaning of its own: the device predates the route. */
export function isOldDevice(e: unknown): boolean {
  return e instanceof HttpError && (e.status === 404 || e.status === 405);
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

export function describeError(e: unknown): string {
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

  constructor(public readonly address: DeviceAddress, private readonly token?: string) {}

  get baseUrl(): string {
    return `http://${this.address.host}:${this.address.port}`;
  }

  get mcpUrl(): string {
    return `${this.baseUrl}/mcp`;
  }

  async fetch(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.token) headers.set('Authorization', `Bearer ${this.token}`);
    const { timeoutMs, ...rest } = init;
    return fetch(this.baseUrl + path, {
      ...rest,
      headers,
      signal: timeoutMs === 0 ? rest.signal : withTimeout(timeoutMs ?? 15000, rest.signal ?? undefined),
    });
  }

  private async json<T>(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
    const res = await this.fetch(path, init);
    const text = await res.text();
    if (!res.ok) throw new HttpError(res.status, text, path);
    return JSON.parse(text) as T;
  }

  health(timeoutMs = 5000): Promise<Health> {
    return this.json<Health>('/health', { timeoutMs });
  }

  /** `unsupported` when the device predates pairing requests. */
  async requestPairing(clientName: string, clientKind: PairClientKind = 'vscode'): Promise<PairRequestCreated | 'unsupported'> {
    const res = await this.fetch('/pair/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: clientName, client_kind: clientKind }),
      timeoutMs: 5000,
    });
    const text = await res.text();
    if (res.ok) return JSON.parse(text) as PairRequestCreated;
    // Older plugins: the auth middleware answers 401 before routing; very old ones may 404/405.
    if (res.status === 401 || res.status === 404 || res.status === 405) return 'unsupported';
    throw new HttpError(res.status, text, '/pair/request');
  }

  /** Long-polls one request; `gone` once the device forgot it (expired, or the plugin restarted). */
  async pollPairing(id: string, waitS = 25, signal?: AbortSignal): Promise<PairPoll | 'gone'> {
    const path = `/pair/request/${encodeURIComponent(id)}?wait=${waitS}`;
    const res = await this.fetch(path, { timeoutMs: (waitS + 10) * 1000, signal });
    const text = await res.text();
    if (res.status === 404) return 'gone';
    if (!res.ok) throw new HttpError(res.status, text, path);
    return JSON.parse(text) as PairPoll;
  }

  async cancelPairing(id: string): Promise<void> {
    await (await this.fetch(`/pair/request/${encodeURIComponent(id)}`, { method: 'DELETE', timeoutMs: 5000 })).text();
  }

  streamStats(): Promise<StreamStats> {
    return this.json<StreamStats>('/stream/stats', { timeoutMs: 5000 });
  }

  /** Throws HttpError(404) on devices without remote input support. */
  getInputSettings(): Promise<InputSettings> {
    return this.json<InputSettings>('/input/settings', { timeoutMs: 5000 });
  }

  setInputEnabled(enabled: boolean): Promise<InputSettings> {
    return this.json<InputSettings>('/input/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
      timeoutMs: 10000,
    });
  }

  /** Throws HttpError(404) on devices without capture. */
  getStreamSettings(): Promise<import('./api').StreamSettings> {
    return this.json<import('./api').StreamSettings>('/stream/settings', { timeoutMs: 5000 });
  }

  setStreamSettings(patch: { fps?: number; quality?: number; width?: number; audio?: boolean }): Promise<import('./api').StreamSettings> {
    return this.json<import('./api').StreamSettings>('/stream/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
      timeoutMs: 15000,
    });
  }

  async frame(): Promise<Uint8Array> {
    const res = await this.fetch('/frame.jpg', { timeoutMs: 10000 });
    if (!res.ok) throw new HttpError(res.status, await res.text(), '/frame.jpg');
    return new Uint8Array(await res.arrayBuffer());
  }

  async rpc<T>(method: string, params?: Record<string, unknown>, timeoutMs = 30000): Promise<T> {
    const id = ++this.rpcId;
    const reply = await this.json<JsonRpcResponse<T>>('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      timeoutMs,
    });
    if (reply.error) throw new Error(`${method}: ${reply.error.message}`);
    return reply.result as T;
  }

  async listTools(): Promise<ToolDescription[]> {
    return (await this.rpc<ToolsListResult>('tools/list')).tools;
  }

  callTool(name: string, args: Record<string, unknown> = {}, timeoutMs = 30000): Promise<ToolCallResult> {
    return this.rpc<ToolCallResult>('tools/call', { name, arguments: args }, timeoutMs);
  }

  async callToolText(name: string, args: Record<string, unknown> = {}, timeoutMs = 30000): Promise<string> {
    const result = await this.callTool(name, args, timeoutMs);
    const text = result.content
      .map(c => (c.type === 'text' ? (c as { text: string }).text : `[${c.type}]`))
      .join('\n');
    if (result.isError) throw new ToolError(`${name}: ${text}`);
    return text;
  }

  /** Falls back to the `list_plugins` tool on devices without the REST route. */
  async listPlugins(): Promise<PluginInfo[]> {
    try {
      return await this.json<PluginInfo[]>('/plugins');
    } catch (e) {
      if (isMissingRoute(e)) return JSON.parse(await this.callToolText('list_plugins')) as PluginInfo[];
      throw e;
    }
  }

  installPlugin(zip: Uint8Array, filename: string, restart: RestartMode = 'loader'): Promise<InstallResult> {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(zip)], { type: 'application/zip' }), filename);
    return this.json<InstallResult>(`/plugins/install?restart=${restart}`, { method: 'POST', body: form, timeoutMs: 120000 });
  }

  async reloadPlugin(dir: string): Promise<unknown> {
    return this.json<unknown>(`/plugins/${encodeURIComponent(dir)}/reload`, { method: 'POST', timeoutMs: 30000 });
  }

  /** Falls back to the `restart_loader` tool on devices without the REST route. */
  async restartLoader(): Promise<string> {
    try {
      const res = await this.json<unknown>('/loader/restart', { method: 'POST' });
      return typeof res === 'string' ? res : JSON.stringify(res);
    } catch (e) {
      if (isMissingRoute(e)) return this.callToolText('restart_loader', { confirm: true });
      throw e;
    }
  }

  controllers(): Promise<ControllersList> {
    return this.json<ControllersList>('/controllers', { timeoutMs: 5000 });
  }

  /** 409 when every explicit slot is taken; the server also refuses pads Steam Input does not pick up. */
  addVirtualController(name?: string): Promise<VirtualPadCreated> {
    return this.json<VirtualPadCreated>('/controllers/virtual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(name ? { name } : {}),
      timeoutMs: 20000,
    });
  }

  removeVirtualController(id: string): Promise<{ removed: unknown }> {
    return this.json<{ removed: unknown }>(`/controllers/virtual/${encodeURIComponent(id)}`, { method: 'DELETE', timeoutMs: 10000 });
  }

  uiRoutes(): Promise<UiRoutes> {
    return this.json<UiRoutes>('/ui/routes', { timeoutMs: 10000 });
  }

  navigate(body: NavigateRequest): Promise<NavigateResult> {
    return this.json<NavigateResult>('/ui/navigate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeoutMs: 15000,
    });
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

  fsList(path: string, glob?: string): Promise<FsListing> {
    const q = new URLSearchParams({ path });
    if (glob) q.set('glob', glob);
    return this.json<FsListing>(`/fs?${q}`, { timeoutMs: 20000 });
  }

  async fsRead(path: string): Promise<Uint8Array> {
    const route = `/fs/read?${new URLSearchParams({ path })}`;
    const res = await this.fetch(route, { timeoutMs: 120000 });
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

  logTail(q: LogQuery): Promise<LogTail> {
    return this.json<LogTail>(`/logs/tail${logQueryString(q)}`);
  }

  /** Resolves when the stream ends; throws HttpError(404) on devices without `/logs/stream`. */
  async streamLogs(q: LogQuery, onLine: (line: string) => void, signal: AbortSignal): Promise<void> {
    const path = `/logs/stream${logQueryString(q)}`;
    const res = await this.fetch(path, { headers: { Accept: 'text/event-stream' }, signal, timeoutMs: 0 });
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
