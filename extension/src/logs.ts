import * as vscode from 'vscode';
import type { LogQuery } from '@decky-toolkit/client/api';
import { DeckyClient, describeError, isConnectionError, isMissingRoute, sleep } from '@decky-toolkit/client/client';
import { Connection, LinkState, linkMessage } from './connection';

const RETRY_MS = 3000;
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
  /** Aborts the current request when the connection drops, so a user Disconnect really stops the stream. */
  private attempt?: AbortController;
  private readonly sub: vscode.Disposable;

  constructor(
    private readonly conn: Connection,
    readonly channel: vscode.OutputChannel,
    private readonly query: LogQuery,
  ) {
    this.sub = conn.onDidChange(() => { if (conn.link !== 'connected') this.attempt?.abort(); });
    void this.loop();
  }

  private append(lines: string[]): void {
    for (const l of lines) this.channel.appendLine(l);
    this.recent = this.recent.concat(lines).slice(-RECENT_MAX);
  }

  private async loop(): Promise<void> {
    const signal = this.abort.signal;
    let paused: LinkState | undefined;
    while (!signal.aborted) {
      const link = this.conn.link;
      if (link !== 'connected') {
        // One line per state instead of an error every retry; the channel stays open and resumes by itself.
        if (link !== paused && link !== 'connecting') this.note(linkMessage(this.conn).split('\n')[0] + ' Output resumes when it is connected again.');
        paused = link === 'connecting' ? paused : link;
        await this.untilLinkChanged(signal);
        continue;
      }
      if (paused) {
        this.note(`Connected to ${this.conn.linkLabel} again.`);
        paused = undefined;
      }
      const identity = await this.conn.identity();
      if (!identity) {
        this.channel.appendLine('[decky-toolkit] not paired; waiting for pairing…');
        await this.untilChanged(signal);
        continue;
      }
      const client = new DeckyClient(this.conn.address, identity);
      const attempt = this.attempt = new AbortController();
      const stop = () => attempt.abort();
      signal.addEventListener('abort', stop);
      if (this.conn.link !== 'connected') attempt.abort();
      try {
        try {
          await this.stream(client, attempt.signal);
        } catch (e) {
          if (signal.aborted) return;
          if (attempt.signal.aborted) continue;
          if (isMissingRoute(e)) {
            this.note('the Decky Toolkit plugin on this device cannot stream logs; update it on the device.');
            await this.untilTargetOrLinkChanged(signal);
            continue;
          }
          // A dropped connection is reported once through the link state, not on every retry.
          if (isConnectionError(e)) void this.conn.checkHealth();
          else this.channel.appendLine(`[decky-toolkit] ${describeError(e)}; retrying…`);
        }
        await sleep(RETRY_MS, attempt.signal).catch(() => undefined);
      } finally {
        signal.removeEventListener('abort', stop);
        this.attempt = undefined;
      }
    }
  }

  private note(text: string): void {
    this.channel.appendLine(`[decky-toolkit] ${text}`);
  }

  private untilLinkChanged(signal: AbortSignal): Promise<void> {
    const from = this.conn.link;
    return new Promise(resolve => {
      const sub = this.conn.onDidChange(() => { if (this.conn.link !== from) { sub.dispose(); resolve(); } });
      signal.addEventListener('abort', () => { sub.dispose(); resolve(); }, { once: true });
    });
  }

  private untilTargetOrLinkChanged(signal: AbortSignal): Promise<void> {
    const from = this.conn.link;
    return new Promise(resolve => {
      const done = () => { subs.forEach(s => s.dispose()); resolve(); };
      const subs = [this.conn.onDidChangeTarget(done), this.conn.onDidChange(() => { if (this.conn.link !== from) done(); })];
      signal.addEventListener('abort', done, { once: true });
    });
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

  dispose(): void {
    this.abort.abort();
    this.sub.dispose();
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
