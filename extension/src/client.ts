import type {
  Health,
  InstallResult,
  JsonRpcResponse,
  LogQuery,
  LogTail,
  PairGrant,
  PluginInfo,
  RestartMode,
  StreamStats,
  ToolCallResult,
  ToolDescription,
  ToolsListResult,
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

  /** `closed` while no pairing window is open; `unsupported` when the device predates `/pair`. */
  async pair(): Promise<PairGrant | 'closed' | 'unsupported'> {
    const res = await this.fetch('/pair', { timeoutMs: 5000 });
    const text = await res.text();
    if (res.ok) return JSON.parse(text) as PairGrant;
    if (res.status === 403) return 'closed';
    // Without the route the auth middleware answers 401 before routing.
    if (res.status === 404 || res.status === 401) return 'unsupported';
    throw new HttpError(res.status, text, '/pair');
  }

  streamStats(): Promise<StreamStats> {
    return this.json<StreamStats>('/stream/stats', { timeoutMs: 5000 });
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
      if (isMissingRoute(e)) return this.callToolText('restart_loader');
      throw e;
    }
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
