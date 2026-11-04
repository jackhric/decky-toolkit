import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { describeError } from './client';
import { Connection, ConnectionState, InputState, externalProxyBase } from './connection';
import { INPUT_UNSUPPORTED, inputBackendLabel, inputOn, toggleInput } from './input';

export class StatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  private readonly sub: vscode.Disposable;

  constructor(private readonly conn: ConnectionState) {
    this.item.command = 'decky-mcp.switchDevice';
    this.sub = conn.onDidChange(() => this.render());
    this.render();
    this.item.show();
  }

  render(): void {
    const d = this.conn.connectedDevice;
    if (!d) {
      this.item.text = '$(vm) Decky: not connected';
      this.item.tooltip = 'Click to connect to a device or add one';
      return;
    }
    const down = this.conn.health.kind === 'unreachable';
    const input = inputOn(this.conn.input);
    this.item.text = `$(${down ? 'warning' : 'vm-connect'}) ${d.name}${down ? ' (unreachable)' : ''}${input ? ' $(keyboard)' : ''}`;
    this.item.tooltip = `Decky: connected to ${d.name} (${d.host}:${d.port})${down ? `, not answering: ${(this.conn.health as { error: string }).error}` : ''}` +
      `${input ? ', remote input on' : ''}. Click for devices`;
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
    const panel = vscode.window.createWebviewPanel('decky-mcp.screen', `Screen: ${conn.label}`, vscode.ViewColumn.Beside, {
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
    let sentInput: string | undefined;
    const sendInput = (force = false) => {
      const state = webviewInputState(conn.input);
      const json = JSON.stringify(state);
      if (!force && json === sentInput) return;
      sentInput = json;
      void panel.webview.postMessage({ type: 'input', state });
    };
    panel.webview.onDidReceiveMessage(async m => {
      if (m?.type === 'snapshot') void vscode.env.openExternal(vscode.Uri.parse(`${this.base}/frame.jpg?t=${Date.now()}`));
      if (m?.type === 'ready') sendInput(true);
      if (m?.type === 'ready' || m?.type === 'refreshInput') void conn.refreshInput();
      // The webview never talks to /input/settings itself; the extension owns the device-wide flag.
      if (m?.type === 'setInput') {
        try {
          await toggleInput(conn, !!m.enabled);
        } catch (e) {
          void vscode.window.showErrorMessage(`Decky-MCP: ${describeError(e)}`);
        }
        sendInput(true);
      }
    }, null, this.disposables);
    conn.onDidChange(() => sendInput(), null, this.disposables);
    conn.onDidChangeTarget(() => {
      panel.title = `Screen: ${conn.label}`;
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
      `connect-src ${origin} ${origin.replace(/^http/, 'ws')}`,
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
<title>Device screen</title>
</head>
<body data-base="${attr(external)}">
<header>
  <b><span class="dot" id="dot"></span>Device</b>
  <span class="stat">fps <span id="fps">–</span></span>
  <span class="stat">Mbps <span id="mbps">–</span></span>
  <span class="stat">res <span id="res">–</span></span>
  <span class="stat">frames <span id="frames">0</span></span>
  <span class="spacer"></span>
  <span class="input-ctl" id="input-ctl" hidden>
    <span id="pad-ind" hidden>Gamepad connected</span>
    <span id="inp-note"></span>
    <span class="seg" id="mode" hidden>
      <button id="mode-ui" class="on" title="Clicks and moves map onto the screen; click the picture to capture the keyboard">UI</button>
      <button id="mode-game" title="Pointer lock: relative mouse for games (Esc releases)">Game</button>
    </span>
    <button id="inp" title="Remote keyboard, mouse and gamepad input (device-wide)">Input</button>
  </span>
  <button id="pause">Pause</button>
  <button id="fit" class="on">Fit</button>
  <button id="snap">Snapshot</button>
</header>
<main id="main" tabindex="-1">
  <img id="img" alt="Device display">
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

/** What media/screen.js needs to draw the Input button; null until the first answer. */
function webviewInputState(input: InputState | undefined) {
  if (!input) return null;
  if (input === 'unsupported') return { supported: false, enabled: false, available: false, backend: null, reason: INPUT_UNSUPPORTED };
  return { supported: true, enabled: input.enabled, available: input.available, backend: inputBackendLabel(input.backend), reason: input.reason };
}
