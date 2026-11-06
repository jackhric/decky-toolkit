import * as vscode from 'vscode';
import type { ControllerInfo, ControllersList, VirtualPad } from '@decky-toolkit/client/api';
import { describeError, isMissingRoute, isOldDevice, parseSse, serverError } from '@decky-toolkit/client/client';
import type { Connection, ConnectionState } from './connection';

/** Mutable so tests can shorten it. */
export const controllerTimings = { pollMs: 5000 };

export const MAX_VIRTUAL_PADS = 4;
export const CONTROLLERS_UNSUPPORTED = 'update Decky Toolkit on the device';

/** `unsupported`: the device answers 404 to `/controllers`. */
export type ControllersState = ControllersList | 'unsupported' | { error: string };

export function isList(s: ControllersState | undefined): s is ControllersList {
  return typeof s === 'object' && 'controllers' in s;
}

/**
 * The connected device's controllers. While at least one lease is held it follows
 * `/controllers/events` through the loopback proxy and falls back to polling when the stream fails.
 */
export class ControllerWatcher implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  state?: ControllersState;
  private leases = 0;
  // Bumped on stop and on target changes so late replies are dropped.
  private gen = 0;
  private events?: AbortController;
  private eventsMissing = false;
  private timer?: NodeJS.Timeout;
  private readonly sub: vscode.Disposable;
  private readonly linkSub: vscode.Disposable;

  constructor(private readonly conn: ConnectionState, private readonly proxyBase: () => Promise<string>) {
    this.sub = conn.onDidChangeTarget(() => {
      this.gen++;
      this.events?.abort();
      this.events = undefined;
      this.eventsMissing = false;
      this.set(undefined);
      if (this.leases > 0) void this.tick();
    });
    let wasConnected = this.connected;
    this.linkSub = conn.onDidChange(() => {
      const now = this.connected;
      if (now === wasConnected) return;
      wasConnected = now;
      if (!now) {
        this.gen++;
        this.events?.abort();
        this.events = undefined;
      } else if (this.leases > 0) {
        void this.tick();
      }
    });
  }

  get connected(): boolean {
    return !!(this.conn.link === 'connected' && this.conn.authedClient());
  }

  watch(): vscode.Disposable {
    if (this.leases++ === 0) {
      this.timer = setInterval(() => void this.tick(), controllerTimings.pollMs);
      void this.tick();
    }
    let released = false;
    return new vscode.Disposable(() => {
      if (released) return;
      released = true;
      if (--this.leases === 0) {
        clearInterval(this.timer);
        this.timer = undefined;
        this.gen++;
        this.events?.abort();
        this.events = undefined;
      }
    });
  }

  /** Polls only while the event stream is not open; reopens it after a drop. */
  private async tick(): Promise<void> {
    if (this.events || !this.connected) return;
    await this.refresh();
    if (this.leases > 0 && isList(this.state) && !this.eventsMissing) void this.follow();
  }

  async refresh(): Promise<ControllersState | undefined> {
    const client = this.connected && this.conn.authedClient();
    if (!client) return undefined;
    const gen = this.gen;
    let next: ControllersState;
    try {
      next = await client.controllers();
    } catch (e) {
      next = isOldDevice(e) ? 'unsupported' : { error: describeError(e) };
    }
    if (gen === this.gen) this.set(next);
    return next;
  }

  private async follow(): Promise<void> {
    if (this.events) return;
    const gen = this.gen;
    const ac = new AbortController();
    this.events = ac;
    try {
      const base = await this.proxyBase();
      const res = await fetch(`${base}/controllers/events`, { headers: { Accept: 'text/event-stream' }, signal: ac.signal });
      if (!res.ok || !res.body) {
        if (res.status === 404) this.eventsMissing = true;
        await res.body?.cancel();
        return;
      }
      await parseSse(res.body, data => {
        if (gen !== this.gen) return;
        let ev: { type?: string; controllers?: ControllerInfo[]; virtual?: VirtualPad[] };
        try {
          ev = JSON.parse(data);
        } catch {
          return;
        }
        if (ev.type !== 'controllers' || !Array.isArray(ev.controllers) || !Array.isArray(ev.virtual)) return;
        const prev = isList(this.state) ? this.state.input_enabled : false;
        this.set({ controllers: ev.controllers, virtual: ev.virtual, input_enabled: prev });
      });
    } catch {
      // dropped or aborted: the next tick polls and reopens it
    } finally {
      if (this.events === ac) this.events = undefined;
    }
  }

  private set(next: ControllersState | undefined): void {
    if (JSON.stringify(next) === JSON.stringify(this.state)) return;
    this.state = next;
    this.changed.fire();
  }

  dispose(): void {
    clearInterval(this.timer);
    this.events?.abort();
    this.sub.dispose();
    this.linkSub.dispose();
    this.changed.dispose();
  }
}

export class ControllerNode extends vscode.TreeItem {
  /** Set on rows backed by a virtual pad the server can remove. */
  virtualId?: string;
}

// Steam Input numbers slots from 0; people count controllers from 1.
export const slotLabel = (slot: number | null | undefined): string => (slot != null ? `Slot ${slot + 1}` : '');

export function steamInputLabel(c: Pick<ControllerInfo, 'kind' | 'steam'>): string {
  if (!c.steam) return `${c.kind} · not seen by Steam Input`;
  const slot = slotLabel(c.steam.slot);
  return `${c.kind} · Steam Input: ${c.steam.type}${slot ? ` · ${slot}` : ''}`;
}

/** Steam Input's order first (by slot), then anything it does not see. */
export function sortControllers<T extends Pick<ControllerInfo, 'steam'>>(list: T[]): T[] {
  const slotOf = (c: T) => (c.steam && c.steam.slot != null ? c.steam.slot : Number.POSITIVE_INFINITY);
  return [...list].sort((a, b) => slotOf(a) - slotOf(b));
}

function controllerRow(c: ControllerInfo, pad: VirtualPad | undefined, order?: number): ControllerNode {
  const virtual = c.kind === 'virtual';
  const base = virtual && !/virtual/i.test(c.name) ? `${c.name} (virtual)` : c.name;
  const n = new ControllerNode(order != null ? `${order}. ${base}` : base);
  n.id = `controller:${c.id}`;
  n.description = steamInputLabel(c);
  n.iconPath = new vscode.ThemeIcon('game', virtual ? new vscode.ThemeColor('charts.blue') : undefined);
  const virtualId = c.virtual_id ?? pad?.id;
  n.virtualId = virtual ? virtualId ?? undefined : undefined;
  n.contextValue = n.virtualId ? 'controller.virtual' : 'controller.physical';
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**${c.name}** · ${c.kind}\n\n`);
  if (c.steam) md.appendMarkdown(`- Steam Input: ${c.steam.type}${c.steam.slot != null ? `, ${slotLabel(c.steam.slot)}` : ''}${c.steam.name ? ` ("${c.steam.name}")` : ''}\n`);
  else md.appendMarkdown('- not seen by Steam Input\n');
  if (c.vendor || c.product) md.appendMarkdown(`- USB id: \`${c.vendor}:${c.product}\`\n`);
  if (c.device) md.appendMarkdown(`- device: \`${c.device}\`\n`);
  if (pad?.auto) md.appendMarkdown('- created automatically for forwarded gamepad input ("Auto")\n');
  if (n.virtualId) md.appendMarkdown(`- virtual pad id: \`${n.virtualId}\`\n`);
  n.tooltip = md;
  return n;
}

/** One row per controller, plus pads the server made that the device list does not show yet. */
export function controllerItems(state: ControllersState | undefined): vscode.TreeItem[] {
  if (state === undefined) return [];
  if (state === 'unsupported') {
    const n = new ControllerNode('Controllers');
    n.description = CONTROLLERS_UNSUPPORTED;
    n.tooltip = 'The Decky Toolkit plugin on this device predates controller management (GET /controllers answers 404).';
    n.iconPath = new vscode.ThemeIcon('game', new vscode.ThemeColor('disabledForeground'));
    n.contextValue = 'controller.unsupported';
    return [n];
  }
  if (!isList(state)) {
    const n = new ControllerNode(`Could not load controllers: ${state.error}`);
    n.iconPath = new vscode.ThemeIcon('warning');
    n.tooltip = 'Click to retry';
    n.command = { command: 'decky-toolkit.refreshControllers', title: 'Retry' };
    n.contextValue = 'placeholder';
    return [n];
  }
  const pads = new Map(state.virtual.map(v => [v.id, v]));
  let order = 0;
  const rows = sortControllers(state.controllers).map(c =>
    controllerRow(c, c.virtual_id ? pads.get(c.virtual_id) : undefined, c.steam && c.steam.slot != null ? ++order : undefined));
  const shown = new Set(state.controllers.map(c => c.virtual_id).filter(Boolean));
  for (const v of state.virtual) {
    if (shown.has(v.id)) continue;
    rows.push(controllerRow({ id: `virtual:${v.id}`, name: v.name, kind: 'virtual', virtual_id: v.id, vendor: '', product: '', device: '', steam: null }, v));
  }
  return rows;
}

export class ControllersTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly sub: vscode.Disposable;

  constructor(private readonly watcher: ControllerWatcher) {
    this.sub = watcher.onDidChange(() => this.changed.fire(undefined));
  }

  refresh(): void {
    void this.watcher.refresh();
  }

  redraw(): void {
    this.changed.fire(undefined);
  }

  getTreeItem(item: vscode.TreeItem): vscode.TreeItem {
    return item;
  }

  async getChildren(item?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (item || !this.watcher.connected) return [];
    // An empty answer shows the welcome text, so wait for the first reply instead of flashing it.
    if (this.watcher.state === undefined) await this.watcher.refresh();
    return controllerItems(this.watcher.state);
  }

  dispose(): void {
    this.sub.dispose();
    this.changed.dispose();
  }
}

function nextPadName(state: ControllersState | undefined): string {
  const names = new Set(isList(state) ? state.virtual.map(v => v.name) : []);
  let n = (isList(state) ? state.virtual.filter(v => !v.auto).length : 0) + 1;
  while (names.has(`Virtual pad ${n}`)) n++;
  return `Virtual pad ${n}`;
}

/** Returns the new pad's id, or undefined when cancelled or refused. */
export async function addVirtualController(conn: Connection, watcher: ControllerWatcher): Promise<string | undefined> {
  const client = await conn.client();
  if (!client) return undefined;
  const state = watcher.state ?? await watcher.refresh();
  if (state === 'unsupported') {
    void vscode.window.showWarningMessage(`Decky Toolkit: controller management needs a newer Decky Toolkit; ${CONTROLLERS_UNSUPPORTED} (${conn.label}).`);
    return undefined;
  }
  const fallback = nextPadName(state);
  const name = await vscode.window.showInputBox({
    title: 'Add virtual controller',
    prompt: `Name for the new Xbox 360 pad on ${conn.label} (Enter for "${fallback}")`,
    placeHolder: fallback,
  });
  if (name === undefined) return undefined;
  try {
    const pad = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Adding ${name.trim() || fallback} on ${conn.label}…` },
      () => client.addVirtualController(name.trim() || fallback));
    void watcher.refresh();
    void vscode.window.showInformationMessage(`Decky Toolkit: Virtual controller added and recognised by Steam Input (${pad.name}).`);
    return pad.id;
  } catch (e) {
    if (isOldDevice(e)) {
      void vscode.window.showWarningMessage(`Decky Toolkit: controller management needs a newer Decky Toolkit; ${CONTROLLERS_UNSUPPORTED} (${conn.label}).`);
      return undefined;
    }
    // 409 (all slots taken) and pads Steam Input did not pick up: the server's text says why.
    void vscode.window.showWarningMessage(`Decky Toolkit: ${serverError(e)}`);
    return undefined;
  }
}

export async function removeVirtualController(conn: Connection, watcher: ControllerWatcher, arg?: unknown): Promise<void> {
  const client = await conn.client();
  if (!client) return;
  let id = typeof arg === 'string' ? arg : (arg as ControllerNode | undefined)?.virtualId;
  let label = arg instanceof ControllerNode ? String(arg.label) : id;
  if (!id) {
    const state = await watcher.refresh();
    if (state === 'unsupported') {
      void vscode.window.showWarningMessage(`Decky Toolkit: controller management needs a newer Decky Toolkit; ${CONTROLLERS_UNSUPPORTED} (${conn.label}).`);
      return;
    }
    const pads = isList(state) ? state.virtual : [];
    if (pads.length === 0) {
      void vscode.window.showInformationMessage(`Decky Toolkit: ${conn.label} has no virtual controllers.`);
      return;
    }
    const pick = await vscode.window.showQuickPick(
      pads.map(p => ({ label: p.name, description: p.auto ? 'auto' : undefined, id: p.id })),
      { placeHolder: 'Remove which virtual controller?' });
    if (!pick) return;
    id = pick.id;
    label = pick.label;
  }
  try {
    await client.removeVirtualController(id);
  } catch (e) {
    if (isMissingRoute(e)) {
      void vscode.window.showWarningMessage(`Decky Toolkit: controller management needs a newer Decky Toolkit; ${CONTROLLERS_UNSUPPORTED} (${conn.label}).`);
      return;
    }
    throw new Error(serverError(e));
  }
  vscode.window.setStatusBarMessage(`Decky Toolkit: removed ${label}`, 4000);
  await watcher.refresh();
}
