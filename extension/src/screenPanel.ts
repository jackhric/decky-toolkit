import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { DeckyClient, describeError } from './client';
import { Connection } from './connection';

export class StatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  private fps?: number;
  private error?: string;

  constructor(private readonly conn: Connection) {
    this.item.command = 'decky-mcp.openScreen';
    conn.onDidChange(() => this.render());
    this.render();
    this.item.show();
  }

  set(fps: number | undefined, error?: string): void {
    this.fps = fps;
    this.error = error;
    this.render();
  }

  private render(): void {
    let text = `$(device-mobile) Decky: ${this.conn.label}`;
    if (!this.conn.paired) text += ' (not paired)';
    else if (this.error) text += ' ○ offline';
    else if (this.fps !== undefined) text += ` ● ${Math.round(this.fps)} fps`;
    this.item.text = text;
    this.item.tooltip = this.error ? `Decky-MCP: ${this.error}` : 'Open the Deck screen';
  }

  dispose(): void {
    this.item.dispose();
  }
}

export class ScreenPanel {
  private static current?: ScreenPanel;
  private poll?: NodeJS.Timeout;
  private readonly disposables: vscode.Disposable[] = [];

  static async show(ctx: vscode.ExtensionContext, conn: Connection, status: StatusBar): Promise<void> {
    if (ScreenPanel.current) {
      ScreenPanel.current.panel.reveal();
      return;
    }
    const base = await conn.proxy.start();
    const external = (await vscode.env.asExternalUri(vscode.Uri.parse(base))).toString(true).replace(/\/$/, '');
    const panel = vscode.window.createWebviewPanel('decky-mcp.screen', `Deck: ${conn.label}`, vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'media')],
    });
    ScreenPanel.current = new ScreenPanel(ctx, conn, status, panel, base, external);
  }

  private constructor(
    ctx: vscode.ExtensionContext,
    private readonly conn: Connection,
    private readonly status: StatusBar,
    private readonly panel: vscode.WebviewPanel,
    private readonly base: string,
    external: string,
  ) {
    panel.webview.html = this.html(ctx, external);
    panel.onDidDispose(() => this.dispose(), null, this.disposables);
    panel.onDidChangeViewState(e => void panel.webview.postMessage({ type: 'visible', visible: e.webviewPanel.visible }), null, this.disposables);
    panel.webview.onDidReceiveMessage(m => {
      if (m?.type === 'snapshot') void vscode.env.openExternal(vscode.Uri.parse(`${this.base}/frame.jpg?t=${Date.now()}`));
    }, null, this.disposables);
    conn.onDidChange(() => {
      panel.title = `Deck: ${conn.label}`;
      void panel.webview.postMessage({ type: 'reconnect' });
    }, null, this.disposables);
    this.poll = setInterval(() => void this.pollStats(), 5000);
    void this.pollStats();
  }

  private async pollStats(): Promise<void> {
    const token = await this.conn.token();
    if (!token) return this.status.set(undefined);
    try {
      const stats = await new DeckyClient(this.conn.address, token).streamStats();
      this.status.set(stats.running ? stats.fps : 0, stats.error ?? undefined);
    } catch (e) {
      this.status.set(undefined, describeError(e));
    }
  }

  private html(ctx: vscode.ExtensionContext, external: string): string {
    const webview = this.panel.webview;
    const origin = new URL(external).origin;
    const nonce = randomBytes(16).toString('base64');
    const media = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, 'media', f));
    const csp = [
      "default-src 'none'",
      `img-src ${origin} blob:`,
      `connect-src ${origin}`,
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${media('screen.css')}">
<title>Deck screen</title>
</head>
<body data-base="${attr(external)}">
<header>
  <b><span class="dot" id="dot"></span>Deck</b>
  <span class="stat">fps <span id="fps">–</span></span>
  <span class="stat">Mbps <span id="mbps">–</span></span>
  <span class="stat">res <span id="res">–</span></span>
  <span class="stat">frames <span id="frames">0</span></span>
  <span class="spacer"></span>
  <button id="pause">Pause</button>
  <button id="fit" class="on">Fit</button>
  <button id="snap">Snapshot</button>
</header>
<main id="main">
  <img id="img" alt="Deck display">
  <div id="msg">Connecting…</div>
</main>
<script nonce="${nonce}" src="${media('screen.js')}"></script>
</body>
</html>`;
  }

  private dispose(): void {
    ScreenPanel.current = undefined;
    clearInterval(this.poll);
    this.status.set(undefined);
    this.disposables.forEach(d => d.dispose());
  }
}
