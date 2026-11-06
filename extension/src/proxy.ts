import * as http from 'http';
import { randomBytes } from 'crypto';
import type { AddressInfo, Socket } from 'net';
import type { Duplex } from 'stream';
import { Identity, deviceRequest } from '@decky-toolkit/client/transport';

export interface ProxyTarget {
  host: string;
  port: number;
  identity: Identity;
}

const SECRET_KEY = 'decky-toolkit.proxySecret';
export const DEFAULT_MCP_PORT = 8766;
// A second window finds the configured port taken and moves up; give up on a fixed port after that many.
const PORT_ATTEMPTS = 20;

/** The slice of `vscode.Memento` the proxy needs, so scripts can run it without VS Code. */
export interface SecretStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

// Browser-identity headers are dropped: the device rejects foreign Origins (vscode-webview://…)
// with 403, and cookies/credentials must come only from the extension.
const DROP_REQUEST_HEADERS = new Set([
  'host', 'origin', 'referer', 'cookie', 'authorization', 'connection', 'keep-alive',
  'proxy-connection', 'te', 'upgrade', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest',
]);
const DROP_RESPONSE_HEADERS = new Set(['set-cookie', 'connection', 'keep-alive', 'www-authenticate']);

/**
 * Loopback HTTP proxy that talks to the device with this editor's pairing, so webviews and MCP clients
 * never hold it or the device address. Every URL carries a random path prefix: anything else on this
 * machine (including web pages in a browser) can reach 127.0.0.1, but cannot guess the prefix. Port and
 * prefix stay the same across restarts so a written `.mcp.json` keeps working.
 */
export class DeviceProxy {
  private server?: http.Server;
  private starting?: Promise<string>;
  private readonly secret: string;
  private readonly upstreams = new Set<http.ClientRequest>();
  private readonly tunnels = new Set<Duplex>();

  constructor(
    private readonly target: () => ProxyTarget | undefined,
    state: SecretStore,
    private readonly port: () => number = () => DEFAULT_MCP_PORT,
  ) {
    let secret = state.get<string>(SECRET_KEY);
    if (!secret) {
      secret = randomBytes(18).toString('base64url');
      void state.update(SECRET_KEY, secret);
    }
    this.secret = secret;
  }

  get running(): boolean {
    return !!this.server?.listening;
  }

  /** Starts on first use and returns the base URL (no trailing slash). */
  start(): Promise<string> {
    if (!this.starting) {
      const first = this.port();
      this.starting = this.listen(first, first);
      this.starting.catch(() => { this.starting = undefined; });
    }
    return this.starting;
  }

  private listen(port: number, first: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const server = http.createServer((req, res) => this.handle(req, res));
      server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));
      server.once('error', (e: NodeJS.ErrnoException) => {
        if (e.code !== 'EADDRINUSE' || port === 0) return reject(e);
        const next = port - first + 1 < PORT_ATTEMPTS && port < 65535 ? port + 1 : 0;
        resolve(this.listen(next, first));
      });
      server.listen(port, '127.0.0.1', () => {
        this.server = server;
        resolve(this.baseUrlFor(server));
      });
    });
  }

  /** The MCP endpoint MCP clients are given (`.mcp.json`, Copy MCP URL). */
  async mcpUrl(): Promise<string> {
    return `${await this.start()}/mcp`;
  }

  /**
   * For a URL this proxy handed out earlier (same prefix) but on another port, the same URL on the
   * current port; undefined for anything else or when nothing changed.
   */
  async rebase(url: string): Promise<string | undefined> {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return undefined;
    }
    if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(u.hostname) || this.devicePath(u.pathname) === undefined) return undefined;
    const base = new URL(await this.start());
    if (u.port === base.port && u.hostname === base.hostname) return undefined;
    return `${base.origin}${u.pathname}${u.search}`;
  }

  stop(): void {
    this.resetUpstreams();
    this.server?.closeAllConnections?.();
    this.server?.close();
    this.server = undefined;
    this.starting = undefined;
  }

  /** Aborts in-flight requests, e.g. after the pairing or host changes. */
  resetUpstreams(): void {
    for (const u of this.upstreams) u.destroy();
    this.upstreams.clear();
    for (const t of this.tunnels) t.destroy();
    this.tunnels.clear();
  }

  private baseUrlFor(server: http.Server): string {
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/${this.secret}`;
  }

  private corsHeaders(req: http.IncomingMessage): Record<string, string> {
    const origin = req.headers.origin;
    return origin
      ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', Vary: 'Origin' }
      : {};
  }

  /** The device path for a proxied URL, or undefined when the secret prefix is missing. */
  private devicePath(url = '/'): string | undefined {
    const prefix = `/${this.secret}`;
    if (url !== prefix && !url.startsWith(prefix + '/') && !url.startsWith(prefix + '?')) return undefined;
    return url.slice(prefix.length) || '/';
  }

  private upstreamHeaders(req: http.IncomingMessage, target: ProxyTarget): http.OutgoingHttpHeaders {
    const headers: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v !== undefined && !DROP_REQUEST_HEADERS.has(k)) headers[k] = v;
    }
    headers.host = `${target.host}:${target.port}`;
    return headers;
  }

  /** WebSocket (`/input`): replay the handshake upstream, then splice the sockets. */
  private handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on('error', () => socket.destroy());
    const path = this.devicePath(req.url);
    const target = this.target();
    if (!path || !target || (req.headers.upgrade ?? '').toLowerCase() !== 'websocket') {
      socket.end(`HTTP/1.1 ${path && !target ? '503 Service Unavailable' : '404 Not Found'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    const headers = this.upstreamHeaders(req, target);
    headers.connection = 'Upgrade';
    headers.upgrade = 'websocket';
    const upstream = deviceRequest(target, { method: 'GET', path, headers });
    this.upstreams.add(upstream);
    this.tunnels.add(socket);
    const drop = () => { this.tunnels.delete(socket); socket.destroy(); };
    socket.on('close', () => { this.tunnels.delete(socket); upstream.destroy(); });

    upstream.on('upgrade', (res, upSocket, upHead) => {
      this.upstreams.delete(upstream);
      this.tunnels.add(upSocket);
      let reply = `HTTP/1.1 ${res.statusCode ?? 101} ${res.statusMessage ?? 'Switching Protocols'}\r\n`;
      for (let i = 0; i < res.rawHeaders.length; i += 2) {
        if (!DROP_RESPONSE_HEADERS.has(res.rawHeaders[i].toLowerCase()) || /^connection$/i.test(res.rawHeaders[i])) {
          reply += `${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}\r\n`;
        }
      }
      socket.write(reply + '\r\n');
      if (upHead.length) socket.write(upHead);
      if (head.length) upSocket.write(head);
      (upSocket as Socket).setNoDelay?.(true);
      (socket as Socket).setNoDelay?.(true);
      upSocket.pipe(socket);
      socket.pipe(upSocket);
      const close = () => { this.tunnels.delete(upSocket); upSocket.destroy(); drop(); };
      upSocket.on('error', close);
      upSocket.on('close', close);
      socket.on('close', close);
    });
    // Not upgraded (401, 404, …): pass the plain HTTP answer through and close.
    upstream.on('response', res => {
      this.upstreams.delete(upstream);
      let reply = `HTTP/1.1 ${res.statusCode ?? 502} ${res.statusMessage ?? ''}\r\nConnection: close\r\n`;
      for (let i = 0; i < res.rawHeaders.length; i += 2) {
        if (!DROP_RESPONSE_HEADERS.has(res.rawHeaders[i].toLowerCase())) reply += `${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}\r\n`;
      }
      socket.write(reply + '\r\n');
      res.pipe(socket);
      res.on('error', drop);
    });
    upstream.on('error', err => {
      this.upstreams.delete(upstream);
      if (socket.writable) socket.end(`HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\nDecky Toolkit proxy: ${err.message}`);
      else drop();
    });
    upstream.end();
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const path = this.devicePath(req.url);
    if (!path) {
      res.writeHead(404).end();
      return;
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, this.corsHeaders(req)).end();
      return;
    }
    const target = this.target();
    if (!target) {
      res.writeHead(503, { 'Content-Type': 'text/plain', ...this.corsHeaders(req) }).end('Decky Toolkit: not paired');
      return;
    }

    const upstream = deviceRequest(target, { method: req.method, path, headers: this.upstreamHeaders(req, target) });
    this.upstreams.add(upstream);
    upstream.setNoDelay(true);

    upstream.on('response', up => {
      const out: http.OutgoingHttpHeaders = { ...this.corsHeaders(req) };
      for (const [k, v] of Object.entries(up.headers)) {
        if (v !== undefined && !DROP_RESPONSE_HEADERS.has(k)) out[k] = v;
      }
      res.writeHead(up.statusCode ?? 502, out);
      res.flushHeaders();
      up.pipe(res);
      up.on('error', () => res.destroy());
    });
    upstream.on('error', err => {
      this.upstreams.delete(upstream);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain', ...this.corsHeaders(req) }).end(`Decky Toolkit proxy: ${err.message}`);
      } else {
        res.destroy();
      }
    });
    upstream.on('close', () => this.upstreams.delete(upstream));
    // The MJPEG and SSE streams never end on their own; tear down upstream when the viewer leaves.
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  }
}
