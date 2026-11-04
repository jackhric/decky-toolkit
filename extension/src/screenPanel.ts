import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { Connection, ConnectionState, externalProxyBase } from './connection';
import type { Layout } from './layout';

export class StatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  private readonly sub: vscode.Disposable;

  constructor(private readonly conn: ConnectionState, private readonly layout: () => Layout = () => 'classic') {
    this.item.command = 'decky-mcp.switchDevice';
    this.sub = conn.onDidChange(() => this.render());
    this.render();
    this.item.show();
  }

  render(): void {
    if (this.layout() !== 'classic') return this.renderSession();
    const { paired, health, stats, statsError } = this.conn;
    const error = health.kind === 'unreachable' ? health.error : statsError;
    let text = `$(device-mobile) Decky: ${this.conn.label}`;
    if (!paired) text += ' (not paired)';
    else if (error) text += ' ○ offline';
    else if (stats) text += ` ● ${Math.round(stats.running ? stats.fps : 0)} fps`;
    this.item.text = text;
    this.item.tooltip = `${error ? `Decky-MCP: ${error}\n` : ''}${this.conn.address.host}:${this.conn.address.port}. Click to switch device or open the screen`;
  }

  private renderSession(): void {
    const d = this.conn.connectedDevice;
    if (!d) {
      this.item.text = '$(vm) Decky: not connected';
      this.item.tooltip = 'Click to connect to a Deck, add one or switch the sidebar layout';
      return;
    }
    const down = this.conn.health.kind === 'unreachable';
    this.item.text = `$(${down ? 'warning' : 'vm-connect'}) ${d.name}${down ? ' (unreachable)' : ''}`;
    this.item.tooltip = `Decky: connected to ${d.name} (${d.host}:${d.port})${down ? `, not answering: ${(this.conn.health as { error: string }).error}` : ''}. Click for devices and layout`;
  }

  dispose(): void {
    this.sub.dispose();
    this.item.dispose();
  }
}

export class ScreenPanel {
  private static current?: ScreenPanel;
  private readonly disposables: vscode.Disposable[] = [];

  static async show(ctx: vscode.ExtensionContext, conn: Connection): Promise<void> {
    if (ScreenPanel.current) {
      ScreenPanel.current.panel.reveal();
      return;
    }
    const { base, external } = await externalProxyBase(conn);
    const panel = vscode.window.createWebviewPanel('decky-mcp.screen', `Deck: ${conn.label}`, vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'media')],
    });
    ScreenPanel.current = new ScreenPanel(ctx, conn, panel, base, external);
  }

  private constructor(
    ctx: vscode.ExtensionContext,
    conn: Connection,
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
    conn.onDidChangeTarget(() => {
      panel.title = `Deck: ${conn.label}`;
      void panel.webview.postMessage({ type: 'reconnect' });
    }, null, this.disposables);
    this.disposables.push(conn.watchStats());
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
    this.disposables.forEach(d => d.dispose());
  }
}
