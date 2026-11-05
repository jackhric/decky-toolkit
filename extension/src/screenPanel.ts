import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { HttpError, describeError } from './client';
import { Connection, ConnectionState, InputState, externalProxyBase } from './connection';
import { ControllerWatcher, addVirtualController, isList } from './controllers';
import { INPUT_UNSUPPORTED, inputBackendLabel, inputOn, toggleInput } from './input';

export class StatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  private readonly sub: vscode.Disposable;

  constructor(private readonly conn: ConnectionState) {
    this.item.command = 'decky-toolkit.switchDevice';
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

  static async show(ctx: vscode.ExtensionContext, conn: Connection, controllers: ControllerWatcher): Promise<void> {
    if (ScreenPanel.current) {
      ScreenPanel.current.panel.reveal();
      return;
    }
    const { base, external } = await externalProxyBase(conn);
    const panel = vscode.window.createWebviewPanel('decky-toolkit.screen', `Screen: ${conn.label}`, vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'media')],
    });
    ScreenPanel.current = new ScreenPanel(ctx, conn, controllers, panel, base, external);
  }

  private constructor(
    ctx: vscode.ExtensionContext,
    conn: Connection,
    controllers: ControllerWatcher,
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
    let sentStream: string | undefined;
    const postStream = (msg: { settings?: StreamSettingsView | null; applied?: string[]; error?: string }) => {
      if (msg.settings !== undefined && !msg.applied) {
        const json = JSON.stringify(msg.settings);
        if (json === sentStream) return;
        sentStream = json;
      }
      void panel.webview.postMessage({ type: 'stream', ...msg });
    };
    const loadStream = async () => {
      const client = conn.authedClient();
      if (!client) return;
      try {
        postStream({ settings: await client.getStreamSettings() });
      } catch (e) {
        if (e instanceof HttpError && e.status === 404) postStream({ settings: null });
      }
    };
    // The "Forward to" choices: the explicit virtual pads ("Auto" is the server's implicit one).
    let sentPads: string | undefined;
    const sendPads = (force = false, select?: string) => {
      const s = controllers.state;
      if (s === undefined || (!isList(s) && s !== 'unsupported')) return;
      const pads = isList(s) ? s.virtual.filter(v => !v.auto).map(v => ({ id: v.id, name: v.name })) : null;
      const json = JSON.stringify(pads);
      if (!force && select === undefined && json === sentPads) return;
      sentPads = json;
      void panel.webview.postMessage({ type: 'pads', pads, ...(select !== undefined ? { select } : {}) });
    };
    controllers.onDidChange(() => sendPads(), null, this.disposables);
    this.disposables.push(controllers.watch());
    panel.webview.onDidReceiveMessage(async m => {
      if (m?.type === 'ready') sendPads(true);
      if (m?.type === 'addPad') {
        const id = await addVirtualController(conn, controllers);
        await controllers.refresh();
        sendPads(true, id);
      }
      if (m?.type === 'ready') { sentStream = undefined; void loadStream(); }
      // Same rule as input: the extension owns device-wide settings, the webview only asks.
      if (m?.type === 'setStream') {
        const patch = pickStreamPatch(m.patch);
        try {
          const client = conn.authedClient();
          if (!client) throw new Error('not paired');
          const settings = await client.setStreamSettings(patch);
          sentStream = JSON.stringify(settings);
          postStream({ settings, applied: Object.keys(patch) });
        } catch (e) {
          postStream({ error: describeError(e) });
          sentStream = undefined;
          void loadStream();
        }
      }
      if (m?.type === 'snapshot') void vscode.env.openExternal(vscode.Uri.parse(`${this.base}/frame.jpg?t=${Date.now()}`));
      if (m?.type === 'ready') sendInput(true);
      if (m?.type === 'ready' || m?.type === 'refreshInput') void conn.refreshInput();
      // The webview never talks to /input/settings itself; the extension owns the device-wide flag.
      if (m?.type === 'setInput') {
        try {
          await toggleInput(conn, !!m.enabled);
        } catch (e) {
          void vscode.window.showErrorMessage(`Decky Toolkit: ${describeError(e)}`);
        }
        sendInput(true);
      }
    }, null, this.disposables);
    conn.onDidChange(() => {
      sendInput();
      // The 5 s stats tick carries the settings, so changes from other clients reach the panel.
      const st = conn.stats?.settings;
      if (st) postStream({ settings: { ...st } });
    }, null, this.disposables);
    conn.onDidChangeTarget(() => {
      panel.title = `Screen: ${conn.label}`;
      void panel.webview.postMessage({ type: 'reconnect' });
      sentStream = undefined;
      void loadStream();
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
      // Chromium checks AudioWorklet modules against script-src (verified), so the inline worklet
      // that plays /audio needs blob: here; worker-src alone is not enough.
      `script-src 'nonce-${nonce}' blob:`,
      'worker-src blob:',
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
  <span class="stat" id="a-stat" hidden>audio kbps <span id="akbps">–</span></span>
  <span class="spacer"></span>
  <span class="settings" id="settings" hidden>
    <button id="gear" title="Stream settings (device-wide)" aria-expanded="false">Stream</button>
    <div id="pop" hidden>
      <label for="s-fps">Frame rate</label>
      <select id="s-fps"><option value="15">15 fps</option><option value="24">24 fps</option><option value="30">30 fps</option><option value="60">60 fps</option></select>
      <label for="s-quality">JPEG quality</label>
      <select id="s-quality"><option value="50">50</option><option value="60">60</option><option value="70">70</option><option value="80">80</option><option value="90">90</option></select>
      <label for="s-width">Size</label>
      <select id="s-width"><option value="0">Native</option><option value="1600">1600 px</option><option value="1280">1280 px</option><option value="960">960 px</option><option value="640">640 px</option></select>
      <label for="s-audio" id="s-audio-label" hidden>Audio</label>
      <input type="checkbox" id="s-audio" title="Stream what the device is playing (device-wide)" hidden>
      <span class="note" id="s-note">Applies to every viewer.</span>
    </div>
  </span>
  <span class="input-ctl" id="input-ctl" hidden>
    <span id="pad-ind" hidden>Gamepad connected</span>
    <label id="pad-fwd" hidden>Forward to <select id="pad-target" title="Which controller on the device receives this gamepad. Auto: the pad the device creates on its own."><option value="">Auto</option></select></label>
    <span id="inp-note"></span>
    <button id="inp" title="Remote keyboard, mouse and gamepad input (device-wide)">Input</button>
  </span>
  <span class="audio-ctl" id="audio-ctl" hidden>
    <span id="a-hint" hidden>Click anywhere to enable audio</span>
    <button id="mute" title="Mute audio on this computer">🔊</button>
    <input type="range" id="vol" min="0" max="100" value="80" title="Volume on this computer">
  </span>
  <button id="pause">Pause</button>
  <button id="fit" class="on">Fit</button>
  <button id="snap">Snapshot</button>
  <button id="full" hidden>Fullscreen</button>
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

type StreamSettingsView = { fps?: number; quality?: number; width?: number; audio?: boolean };

/** Only the known fields of a webview request, with the types the device expects. */
function pickStreamPatch(raw: unknown): StreamSettingsView {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: StreamSettingsView = {};
  for (const k of ['fps', 'quality', 'width'] as const) if (typeof p[k] === 'number' && Number.isFinite(p[k])) out[k] = p[k] as number;
  if (typeof p.audio === 'boolean') out.audio = p.audio;
  return out;
}
