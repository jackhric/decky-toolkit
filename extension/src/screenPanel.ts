import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import type { StreamSettings } from './api';
import { HttpError, describeError } from './client';
import { Connection, ConnectionState, InputState, externalProxyBase, linkMessage, linkSuffix } from './connection';
import { ControllerWatcher, addVirtualController, isList } from './controllers';
import { inputOn } from './input';

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
    this.item.command = 'decky-toolkit.switchDevice';
    this.item.backgroundColor = undefined;
    if (!d) {
      this.item.text = '$(vm) Decky: not connected';
      this.item.tooltip = 'Click to connect to a device or add one';
      return;
    }
    const h = this.conn.health;
    if (h.kind === 'unreachable' || this.conn.tokenRejected) {
      const lost = h.kind === 'unreachable';
      this.item.text = `$(${lost ? 'debug-disconnect' : 'key'}) ${d.name}: ${lost ? 'connection lost' : 'token rejected'}`;
      this.item.tooltip = lost
        ? `Decky: lost connection to ${d.name} (${d.host}:${d.port}): ${h.error}. Reconnecting as soon as it answers. Click to reconnect now`
        : `Decky: ${d.name} (${d.host}:${d.port}) rejected the stored token. Click to pair again`;
      this.item.backgroundColor = new vscode.ThemeColor(lost ? 'statusBarItem.warningBackground' : 'statusBarItem.errorBackground');
      this.item.command = 'decky-toolkit.reconnect';
      return;
    }
    const input = inputOn(this.conn.input);
    this.item.text = `$(vm-connect) ${d.name}${input ? ' $(keyboard)' : ''}`;
    this.item.tooltip = `Decky: connected to ${d.name} (${d.host}:${d.port})${input ? ', remote input on' : ''}. Click for devices`;
  }

  dispose(): void {
    this.sub.dispose();
    this.item.dispose();
  }
}

const MUTED_KEY = 'decky-toolkit.screen.muted';
const VOLUME_KEY = 'decky-toolkit.screen.volume';
const FPS = [15, 24, 30, 60];
const QUALITY = [50, 60, 70, 80, 90];
const WIDTHS = [0, 1600, 1280, 960, 640];
const VOLUMES = [100, 80, 60, 40, 20, 10];

type StreamPatch = { fps?: number; quality?: number; width?: number; audio?: boolean };
type Choice<T> = vscode.QuickPickItem & { value?: T; run?: () => Promise<void> };

const widthLabel = (w: number) => (w ? `${w} px wide` : 'Native');

/**
 * The live screen. The webview only draws the picture; every control is a native editor title action
 * whose icon follows the `decky-toolkit.screen.*` context keys set here.
 */
export class ScreenPanel {
  private static current?: ScreenPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private paused = false;
  private muted: boolean;
  private volume: number;
  private padTarget = '';
  /** undefined until loaded, null on a device without stream settings. */
  private stream?: StreamSettings | null;

  static async show(ctx: vscode.ExtensionContext, conn: Connection, controllers: ControllerWatcher): Promise<void> {
    if (ScreenPanel.current) {
      ScreenPanel.current.panel.reveal();
      return;
    }
    const { external } = await externalProxyBase(conn);
    const panel = vscode.window.createWebviewPanel('decky-toolkit.screen', screenTitle(conn), vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'media')],
    });
    ScreenPanel.current = new ScreenPanel(ctx, conn, controllers, panel, external);
  }

  static pause(paused: boolean): void { ScreenPanel.current?.setPaused(paused); }
  static mute(muted: boolean): void { ScreenPanel.current?.setMuted(muted); }
  static async settings(): Promise<void> { await ScreenPanel.current?.showSettings(); }

  private constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly conn: Connection,
    private readonly controllers: ControllerWatcher,
    private readonly panel: vscode.WebviewPanel,
    external: string,
  ) {
    this.muted = ctx.globalState.get<boolean>(MUTED_KEY, false);
    this.volume = ctx.globalState.get<number>(VOLUME_KEY, 0.8);
    panel.webview.html = this.html(external, conn.link === 'connected' ? '' : linkMessage(conn));
    panel.onDidDispose(() => this.dispose(), null, this.disposables);
    panel.onDidChangeViewState(e => void this.post({ type: 'visible', visible: e.webviewPanel.visible }), null, this.disposables);
    let sentInput: string | undefined;
    const sendInput = (force = false) => {
      const state = webviewInputState(conn.input);
      const json = JSON.stringify(state);
      if (!force && json === sentInput) return;
      sentInput = json;
      void this.post({ type: 'input', state });
      void setContext('input', state?.enabled ? 'on' : 'off');
    };
    controllers.onDidChange(() => this.checkPadTarget(), null, this.disposables);
    this.disposables.push(controllers.watch());
    let sentLive: boolean | undefined, sentText: string | undefined;
    const sendLink = (force = false) => {
      const live = conn.link === 'connected';
      const text = live ? '' : linkMessage(conn);
      panel.title = screenTitle(conn);
      if (!force && live === sentLive && text === sentText) return;
      // Settings may have changed while the device was away.
      if (live && sentLive === false) void this.loadStream();
      sentLive = live;
      sentText = text;
      void this.post({ type: 'link', live, text });
      void setContext('live', live);
    };
    panel.webview.onDidReceiveMessage(m => {
      // The stream failed: check now instead of waiting for the next /health poll.
      if (m?.type === 'lost') void conn.checkHealth().then(h => { if (h.kind === 'ok') void conn.refreshInput(); });
      if (m?.type === 'ready') {
        sendLink(true);
        sendInput(true);
        this.sendAudio();
        void this.post({ type: 'paused', paused: this.paused });
        void this.post({ type: 'padTarget', id: this.padTarget });
        void this.loadStream();
      }
      if (m?.type === 'ready' || m?.type === 'refreshInput') void conn.refreshInput();
    }, null, this.disposables);
    conn.onDidChange(() => {
      sendLink();
      sendInput();
      // The 5 s stats tick carries the settings, so changes from other clients reach the panel.
      const st = conn.stats?.settings;
      if (st && this.stream) this.setStream({ ...this.stream, ...st });
    }, null, this.disposables);
    conn.onDidChangeTarget(() => {
      sendLink();
      void this.post({ type: 'reconnect' });
      this.stream = undefined;
      void this.loadStream();
    }, null, this.disposables);
    this.disposables.push(conn.watchStats());
    void setContext('live', conn.link === 'connected');
    void setContext('paused', false);
    void setContext('muted', this.muted);
    void setContext('audio', false);
  }

  private post(m: Record<string, unknown>): Thenable<boolean> {
    return this.panel.webview.postMessage(m);
  }

  private async loadStream(): Promise<void> {
    const client = this.conn.authedClient();
    if (!client) return;
    try {
      this.setStream(await client.getStreamSettings());
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) this.setStream(null);
    }
  }

  private setStream(s: StreamSettings | null): void {
    const audioBefore = this.stream?.audio;
    this.stream = s;
    if (s?.audio !== audioBefore) this.sendAudio();
  }

  private sendAudio(): void {
    const on = this.stream?.audio === true;
    void setContext('audio', on);
    void this.post({ type: 'audio', on, muted: this.muted, volume: this.volume });
  }

  private setPaused(paused: boolean): void {
    this.paused = paused;
    void setContext('paused', paused);
    void this.post({ type: 'paused', paused });
  }

  private setMuted(muted: boolean): void {
    this.muted = muted;
    void this.ctx.globalState.update(MUTED_KEY, muted);
    void setContext('muted', muted);
    this.sendAudio();
  }

  private setVolume(volume: number): void {
    this.volume = volume;
    void this.ctx.globalState.update(VOLUME_KEY, volume);
    if (this.muted) this.setMuted(false); else this.sendAudio();
  }

  private virtualPads(): { id: string; name: string }[] | null {
    const s = this.controllers.state;
    return isList(s) ? s.virtual.filter(v => !v.auto).map(v => ({ id: v.id, name: v.name })) : null;
  }

  /** A removed pad falls back to Auto, the pad the device creates on its own. */
  private checkPadTarget(): void {
    const pads = this.virtualPads();
    if (this.padTarget && pads && !pads.some(p => p.id === this.padTarget)) this.setPadTarget('');
  }

  private setPadTarget(id: string): void {
    this.padTarget = id;
    void this.post({ type: 'padTarget', id });
  }

  private async applyStream(patch: StreamPatch): Promise<void> {
    try {
      const client = this.conn.authedClient();
      if (!client) throw new Error('not paired');
      this.setStream(await client.setStreamSettings(patch));
      // The video pipeline has restarted by the time PUT returns, so the next frame is from the new one.
      if (Object.keys(patch).some(k => k !== 'audio')) void this.post({ type: 'applying' });
    } catch (e) {
      void vscode.window.showErrorMessage(`Decky Toolkit: stream settings: ${describeError(e)}`);
      void this.loadStream();
    }
  }

  private async showSettings(): Promise<void> {
    const s = this.stream;
    const section = (label: string): Choice<never> => ({ label, kind: vscode.QuickPickItemKind.Separator });
    const items: Choice<never>[] = [];
    if (s) {
      items.push(
        section('Stream · every client'),
        { label: '$(dashboard) Frame rate', description: `${s.fps} fps`, run: () => this.choose('Frame rate', FPS, s.fps, v => `${v} fps`, fps => this.applyStream({ fps })) },
        { label: '$(symbol-color) JPEG quality', description: String(s.quality), run: () => this.choose('JPEG quality', QUALITY, s.quality, String, quality => this.applyStream({ quality })) },
        { label: '$(screen-full) Size', description: widthLabel(s.width), run: () => this.choose('Size', WIDTHS, s.width, widthLabel, width => this.applyStream({ width })) },
      );
      if (typeof s.audio === 'boolean') {
        items.push({ label: '$(unmute) Audio', description: s.audio ? 'On' : 'Off', run: () => this.applyStream({ audio: !s.audio }) });
      }
    }
    items.push(section('This computer'));
    if (s?.audio) {
      const pct = Math.round(this.volume * 100);
      items.push({ label: '$(unmute) Volume', description: this.muted ? `${pct}% (muted)` : `${pct}%`,
        run: () => this.choose('Volume on this computer', VOLUMES, pct, v => `${v}%`, async v => this.setVolume(v / 100)) });
    }
    const pads = this.virtualPads();
    if (pads) {
      const current = pads.find(p => p.id === this.padTarget)?.name ?? 'Auto';
      items.push({ label: '$(game) Gamepad goes to', description: current, run: () => this.choosePad(pads) });
    }
    const pick = await vscode.window.showQuickPick(items, { title: `Screen: ${this.conn.label}`, placeHolder: 'Stream settings' });
    await pick?.run?.();
  }

  private async choose<T>(title: string, values: T[], current: T, label: (v: T) => string, apply: (v: T) => Promise<void>): Promise<void> {
    const all = values.includes(current) ? values : [...values, current];
    const pick = await vscode.window.showQuickPick(all.map((v): Choice<T> => ({
      label: label(v), value: v, description: v === current ? 'current' : undefined,
    })), { title, placeHolder: label(current) });
    if (pick && pick.value !== current) await apply(pick.value as T);
  }

  private async choosePad(pads: { id: string; name: string }[]): Promise<void> {
    const items: Choice<string>[] = [
      { label: 'Auto', detail: 'The pad the device creates for forwarded input on its own', value: '' },
      ...pads.map(p => ({ label: p.name, value: p.id })),
      { label: '$(add) New virtual pad…', run: async () => {
        const id = await addVirtualController(this.conn, this.controllers);
        if (id) { await this.controllers.refresh(); this.setPadTarget(id); }
      } },
    ];
    for (const i of items) if (i.value === this.padTarget) i.description = 'current';
    const pick = await vscode.window.showQuickPick(items, { title: 'Gamepad goes to', placeHolder: 'Which controller on the device receives your gamepad' });
    if (!pick) return;
    if (pick.run) await pick.run(); else this.setPadTarget(pick.value ?? '');
  }

  private html(external: string, offline: string): string {
    const webview = this.panel.webview;
    const origin = new URL(external).origin;
    const nonce = randomBytes(16).toString('base64');
    const media = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'media', f));
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
<body data-base="${attr(external)}" data-live="${!offline}">
<main id="main" tabindex="-1"${offline ? ' class="offline"' : ''}>
  <img id="img" alt="Device display">
  <div id="msg">${esc(offline || 'Connecting…')}</div>
  <div id="hint" hidden></div>
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

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

/** The tab title carries the connection state, so a background tab shows it too. */
function screenTitle(conn: ConnectionState): string {
  const suffix = linkSuffix(conn.link);
  return `Screen: ${conn.label}${suffix ? ` (${suffix})` : ''}`;
}

function setContext(key: string, value: unknown): Thenable<unknown> {
  return vscode.commands.executeCommand('setContext', `decky-toolkit.screen.${key}`, value);
}

/** What media/screen.js needs for remote input; null until the first answer. */
function webviewInputState(input: InputState | undefined) {
  if (!input || input === 'unsupported') return null;
  return { enabled: input.enabled };
}
