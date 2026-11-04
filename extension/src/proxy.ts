import * as http from 'http';
import { randomBytes } from 'crypto';
import type { AddressInfo } from 'net';

export interface ProxyTarget {
  host: string;
  port: number;
  token: string;
}

// Browser-identity headers are dropped: the device rejects foreign Origins (vscode-webview://…)
// with 403, and cookies/credentials must come only from the extension.
const DROP_REQUEST_HEADERS = new Set([
  'host', 'origin', 'referer', 'cookie', 'authorization', 'connection', 'keep-alive',
  'proxy-connection', 'te', 'upgrade', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest',
]);
const DROP_RESPONSE_HEADERS = new Set(['set-cookie', 'connection', 'keep-alive', 'www-authenticate']);

/**
 * Loopback HTTP proxy that adds the bearer token, so webviews never see the token or the device
 * address. Every URL carries a random path prefix: anything else on this machine (including web
 * pages in a browser) can reach 127.0.0.1, but cannot guess the prefix.
 */
export class DeviceProxy {
  private server?: http.Server;
  private starting?: Promise<string>;
  private readonly secret = randomBytes(18).toString('base64url');
  private readonly upstreams = new Set<http.ClientRequest>();

  constructor(private readonly target: () => ProxyTarget | undefined) {}

  get running(): boolean {
    return !!this.server?.listening;
  }

  /** Starts on first use and returns the base URL (no trailing slash). */
  start(): Promise<string> {
    if (!this.starting) {
      this.starting = new Promise<string>((resolve, reject) => {
        const server = http.createServer((req, res) => this.handle(req, res));
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
          this.server = server;
          resolve(this.baseUrlFor(server));
        });
      });
      this.starting.catch(() => { this.starting = undefined; });
    }
    return this.starting;
  }

  stop(): void {
    for (const u of this.upstreams) u.destroy();
    this.upstreams.clear();
    this.server?.closeAllConnections?.();
    this.server?.close();
    this.server = undefined;
    this.starting = undefined;
  }

  /** Aborts in-flight requests, e.g. after the token or host changes. */
  resetUpstreams(): void {
    for (const u of this.upstreams) u.destroy();
    this.upstreams.clear();
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

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const prefix = `/${this.secret}`;
    const url = req.url ?? '/';
    if (url !== prefix && !url.startsWith(prefix + '/') && !url.startsWith(prefix + '?')) {
      res.writeHead(404).end();
      return;
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, this.corsHeaders(req)).end();
      return;
    }
    const target = this.target();
    if (!target) {
      res.writeHead(503, { 'Content-Type': 'text/plain', ...this.corsHeaders(req) }).end('Decky-MCP: not paired');
      return;
    }

    const headers: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v !== undefined && !DROP_REQUEST_HEADERS.has(k)) headers[k] = v;
    }
    headers.authorization = `Bearer ${target.token}`;
    headers.host = `${target.host}:${target.port}`;

    const upstream = http.request({
      host: target.host,
      port: target.port,
      method: req.method,
      path: url.slice(prefix.length) || '/',
      headers,
    });
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
        res.writeHead(502, { 'Content-Type': 'text/plain', ...this.corsHeaders(req) }).end(`Decky-MCP proxy: ${err.message}`);
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
