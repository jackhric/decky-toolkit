import * as vscode from 'vscode';
import type { LogQuery } from './api';
import { DeckyClient, describeError, isConnectionError, isMissingRoute, sleep } from './client';
import { Connection } from './connection';

const POLL_MS = 3000;
const RECENT_MAX = 400;

/** Lines of `next` that come after the longest suffix of `prev` it starts with. */
export function newLines(prev: string[], next: string[]): string[] {
  for (let k = Math.min(prev.length, next.length); k > 0; k--) {
    let match = true;
    for (let i = 0; i < k; i++) {
      if (prev[prev.length - k + i] !== next[i]) { match = false; break; }
    }
    if (match) return next.slice(k);
  }
  // No overlap: either everything is new or `next` lies wholly inside what we already showed.
  const seen = new Set(prev);
  return next.filter(l => !seen.has(l));
}

class LogSession {
  private readonly abort = new AbortController();
  private recent: string[] = [];

  constructor(
    private readonly conn: Connection,
    readonly channel: vscode.OutputChannel,
    private readonly query: LogQuery,
  ) {
    void this.loop();
  }

  private append(lines: string[]): void {
    for (const l of lines) this.channel.appendLine(l);
    this.recent = this.recent.concat(lines).slice(-RECENT_MAX);
  }

  private async loop(): Promise<void> {
    const signal = this.abort.signal;
    let mode: 'stream' | 'poll' = 'stream';
    while (!signal.aborted) {
      const token = await this.conn.token();
      if (!token) {
        this.channel.appendLine('[decky-toolkit] not paired; waiting for a token…');
        await this.untilChanged(signal);
        continue;
      }
      const client = new DeckyClient(this.conn.address, token);
      try {
        if (mode === 'stream') await this.stream(client, signal);
        else await this.pollOnce(client);
      } catch (e) {
        if (signal.aborted) return;
        if (mode === 'stream' && isMissingRoute(e)) {
          this.channel.appendLine('[decky-toolkit] /logs/stream not available on this device; polling via MCP every 3 s');
          mode = 'poll';
          continue;
        }
        if (!isConnectionError(e) || mode === 'stream') this.channel.appendLine(`[decky-toolkit] ${describeError(e)}; retrying…`);
      }
      await sleep(POLL_MS, signal).catch(() => undefined);
    }
  }

  private untilChanged(signal: AbortSignal): Promise<void> {
    return new Promise(resolve => {
      const sub = this.conn.onDidChangeTarget(() => { sub.dispose(); resolve(); });
      signal.addEventListener('abort', () => { sub.dispose(); resolve(); }, { once: true });
    });
  }

  private async stream(client: DeckyClient, signal: AbortSignal): Promise<void> {
    // After a reconnect the server replays `tail` lines; hold the first burst back and drop what
    // we already printed.
    let pending: string[] | undefined = this.recent.length ? [] : undefined;
    const flush = setTimeout(() => {
      if (pending) this.append(newLines(this.recent, pending));
      pending = undefined;
    }, 750);
    try {
      await client.streamLogs({ ...this.query, tail: this.query.tail ?? 100 }, line => {
        if (pending) pending.push(line);
        else this.append([line]);
      }, signal);
    } finally {
      clearTimeout(flush);
      if (pending) this.append(newLines(this.recent, pending));
    }
  }

  private async pollOnce(client: DeckyClient): Promise<void> {
    let text: string;
    if (this.query.source === 'plugin' && this.query.plugin) {
      const raw = await client.callToolText('read_plugin_log', { plugin_dir: this.query.plugin, lines: 200 });
      text = (JSON.parse(raw) as { text?: string }).text ?? '';
    } else {
      text = await client.callToolText('loader_log', { lines: 200 });
    }
    const lines = text.split('\n').filter(l => l.length > 0);
    this.append(newLines(this.recent, lines));
  }

  dispose(): void {
    this.abort.abort();
  }
}

export class LogManager implements vscode.Disposable {
  private readonly sessions = new Map<string, LogSession>();

  constructor(private readonly conn: Connection) {}

  show(key: string, title: string, query: LogQuery): void {
    let s = this.sessions.get(key);
    if (!s) {
      s = new LogSession(this.conn, vscode.window.createOutputChannel(title, 'log'), query);
      this.sessions.set(key, s);
    }
    s.channel.show(true);
  }

  dispose(): void {
    for (const s of this.sessions.values()) {
      s.dispose();
      s.channel.dispose();
    }
    this.sessions.clear();
  }
}
