import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import type { Health, InputSettings, StreamStats } from './api';
import { DeckyClient, DeviceAddress, HttpError, describeError, isConnectionError, isRejection } from './client';
import { DEFAULT_MCP_PORT, DeviceProxy, ProxyTarget } from './proxy';
import type { Identity } from './transport';

const STATS_POLL_MS = 5000;
const DEVICES_KEY = 'decky-toolkit.devices';
const ACTIVE_KEY = 'decky-toolkit.activeDevice';
const SESSION_KEY = 'decky-toolkit.connectedDevice';
const IDENTITY_PREFIX = 'decky-toolkit.identity:';
// Bearer tokens of plugins before pairing moved to client identities; deleted on sight.
const LEGACY_TOKEN_PREFIX = 'decky-toolkit.token:';

/** Mutable so tests can shorten them. */
export const connectionTimings = { healthPollMs: 15000, retryMs: 2000 };

export type DeviceStatus = 'unpaired' | 'disconnected' | 'connecting' | 'pairing' | 'connected' | 'unreachable';

export interface SavedDevice {
  id: string;
  name: string;
  host: string;
  port: number;
}

/** `unsupported`: the device answers 404 to `/input/settings` (plugin predates remote input). */
export type InputState = InputSettings | 'unsupported';

/**
 * What every device-backed surface shows. Undefined until the first connect of this window, so the views
 * appear once and then stay put; `disconnected` is a session the user ended (or a device switch in progress).
 */
export type LinkState = 'connecting' | 'connected' | 'unreachable' | 'rejected' | 'disconnected';

export type HealthState =
  | { kind: 'unknown' }
  | { kind: 'ok'; health: Health }
  | { kind: 'unreachable'; error: string };

/** What the status bar, trees and preview read; `Connection` is the only implementation. */
export interface ConnectionState {
  readonly devices: SavedDevice[];
  readonly activeDevice: SavedDevice | undefined;
  readonly address: DeviceAddress;
  readonly label: string;
  readonly paired: boolean;
  readonly rejected: boolean;
  readonly health: HealthState;
  readonly stats?: StreamStats;
  readonly statsError?: string;
  /** Undefined until the first `/input/settings` answer for the connected device. */
  readonly input?: InputState;
  readonly onDidChange: vscode.Event<void>;
  /** Host, port or pairing changed; unlike `onDidChange` not fired for health/stats updates. */
  readonly onDidChangeTarget: vscode.Event<void>;
  /** The device of the current session; stays set while it is briefly unreachable. */
  readonly connectedDevice: SavedDevice | undefined;
  readonly onDidChangeStatus: vscode.Event<void>;
  readonly link: LinkState | undefined;
  /** Name of the device `link` is about. */
  readonly linkLabel: string;
  statusOf(device: SavedDevice): DeviceStatus;
  /** The code the device shows for a pairing request that is waiting for approval. */
  pairingCodeOf?(id: string): string | undefined;
  /** Plugin version from the device's last `/health` answer; `/health` needs no pairing, so it is known before pairing. */
  versionOf?(id: string): string | undefined;
  authedClient(): DeckyClient | undefined;
  /** Polls `/stream/stats` while at least one returned lease is undisposed. */
  watchStats(): vscode.Disposable;
}

export class Connection implements ConnectionState, vscode.Disposable {
  private cachedIdentity?: Identity;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly targetChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeTarget = this.targetChanged.event;
  private readonly statusChanged = new vscode.EventEmitter<void>();
  /** Some device's `statusOf` may have changed. */
  readonly onDidChangeStatus = this.statusChanged.event;
  readonly proxy: DeviceProxy;
  private readonly disposables: vscode.Disposable[] = [this.changed, this.targetChanged, this.statusChanged];

  health: HealthState = { kind: 'unknown' };
  stats?: StreamStats;
  statsError?: string;
  input?: InputState;
  rejected = false;
  private statsLeases = 0;
  private statsTimer?: NodeJS.Timeout;
  // Bumped on every refresh so replies for a previous host/pairing are dropped.
  private generation = 0;
  private readonly hasIdentity = new Map<string, boolean>();
  private readonly busy = new Map<string, 'connecting' | 'pairing'>();
  private readonly unreachableIds = new Set<string>();
  private readonly versions = new Map<string, string>();
  private session?: SavedDevice;
  /** The device of the latest session in this window, kept after it ends. */
  private recent?: SavedDevice;
  private healthTimer?: NodeJS.Timeout;
  private probeTimer?: NodeJS.Timeout;

  constructor(private readonly ctx: vscode.ExtensionContext) {
    this.proxy = new DeviceProxy(() => this.proxyTarget(), ctx.globalState,
      () => vscode.workspace.getConfiguration('decky-toolkit').get<number>('mcpPort', DEFAULT_MCP_PORT));
    this.disposables.push(
      ctx.secrets.onDidChange(e => {
        if (e.key === this.secretKey) void this.refresh();
        else if (e.key.startsWith(IDENTITY_PREFIX)) void this.loadIdentityFlags().then(() => this.fireStatus());
      }),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('decky-toolkit.host') || e.affectsConfiguration('decky-toolkit.port')) void this.refresh();
      }),
    );
  }

  private get settingsAddress(): DeviceAddress {
    const cfg = vscode.workspace.getConfiguration('decky-toolkit');
    return { host: cfg.get<string>('host', '').trim(), port: cfg.get<number>('port', 8765) };
  }

  /** Seeds the device list from the host/port settings the first time the extension runs. */
  async initDevices(): Promise<void> {
    await Promise.all(this.devices.map(d => this.ctx.secrets.delete(LEGACY_TOKEN_PREFIX + addressKey(d))));
    if (this.ctx.globalState.get<SavedDevice[]>(DEVICES_KEY) !== undefined) return;
    const { host, port } = this.settingsAddress;
    if (!host) return;
    const seed: SavedDevice = { id: newDeviceId(), name: host, host, port };
    await this.ctx.globalState.update(DEVICES_KEY, [seed]);
    await this.ctx.globalState.update(ACTIVE_KEY, seed.id);
  }

  get devices(): SavedDevice[] {
    return this.ctx.globalState.get<SavedDevice[]>(DEVICES_KEY) ?? [];
  }

  get activeDevice(): SavedDevice | undefined {
    const list = this.devices;
    const id = this.ctx.globalState.get<string>(ACTIVE_KEY);
    return list.find(d => d.id === id) ?? list[0];
  }

  async saveDevices(devices: SavedDevice[], activeId = this.activeDevice?.id): Promise<void> {
    await this.ctx.globalState.update(DEVICES_KEY, devices);
    await this.ctx.globalState.update(ACTIVE_KEY, devices.some(d => d.id === activeId) ? activeId : devices[0]?.id);
    await this.refresh();
    const unknown = devices.filter(d => !this.versions.has(d.id)).map(d => d.id);
    if (unknown.length) void this.probeAll(unknown);
  }

  async setActive(id: string): Promise<void> {
    await this.saveDevices(this.devices, id);
  }

  /** The active saved device, or the host/port settings when the list is empty. */
  get address(): DeviceAddress {
    const d = this.activeDevice;
    return d ? { host: d.host, port: d.port } : this.settingsAddress;
  }

  get label(): string {
    const d = this.activeDevice;
    if (d) return d.name;
    const { host, port } = this.address;
    return port === 8765 ? host : `${host}:${port}`;
  }

  async identityFor(address: DeviceAddress): Promise<Identity | undefined> {
    return parseIdentity(await this.ctx.secrets.get(secretKeyFor(address)));
  }

  async deleteIdentityFor(address: DeviceAddress): Promise<void> {
    await this.ctx.secrets.delete(secretKeyFor(address));
    this.hasIdentity.set(addressKey(address), false);
  }

  async setIdentityFor(address: DeviceAddress, identity: Identity): Promise<void> {
    await this.ctx.secrets.store(secretKeyFor(address), JSON.stringify(identity));
    this.hasIdentity.set(addressKey(address), true);
    if (secretKeyFor(address) === this.secretKey) await this.refresh();
    else this.fireStatus();
  }

  private get secretKey(): string {
    return secretKeyFor(this.address);
  }

  get paired(): boolean {
    return !!this.cachedIdentity;
  }

  async refresh(): Promise<void> {
    const gen = ++this.generation;
    const identity = await this.identityFor(this.address);
    await this.loadIdentityFlags();
    if (gen !== this.generation) return;
    this.cachedIdentity = identity;
    const s = this.session, a = this.activeDevice;
    if (s && !(a && identity && a.id === s.id && a.host === s.host && a.port === s.port)) this.endSession();
    this.proxy.resetUpstreams();
    this.health = { kind: 'unknown' };
    this.stats = undefined;
    this.statsError = undefined;
    this.input = undefined;
    this.rejected = false;
    this.targetChanged.fire();
    this.statusChanged.fire();
    this.changed.fire();
    void this.checkHealth();
    if (this.statsLeases > 0) void this.pollStats();
  }

  async checkHealth(): Promise<HealthState> {
    const gen = this.generation;
    let next: HealthState;
    try {
      next = { kind: 'ok', health: await this.unauthenticatedClient().health() };
    } catch (e) {
      next = { kind: 'unreachable', error: describeError(e) };
    }
    if (gen === this.generation) {
      if (next.kind === 'ok' && this.session) this.noteVersion(this.session.id, next.health.version);
      this.setHealth(next);
    }
    return next;
  }

  private setHealth(next: HealthState): void {
    if (JSON.stringify(next) === JSON.stringify(this.health)) return;
    const wasDown = this.health.kind === 'unreachable';
    this.health = next;
    if (this.session && wasDown !== (next.kind === 'unreachable')) this.scheduleHealth();
    if (this.session) this.statusChanged.fire();
    this.changed.fire();
  }

  private setRejected(rejected: boolean): void {
    if (rejected === this.rejected) return;
    this.rejected = rejected;
    this.fireStatus();
  }

  get link(): LinkState | undefined {
    const s = this.connectedDevice;
    if (s) {
      if (this.busy.has(s.id)) return 'connecting';
      if (this.rejected) return 'rejected';
      return this.health.kind === 'unreachable' ? 'unreachable' : 'connected';
    }
    if (!this.recent || this.devices.length === 0) return undefined;
    return this.busy.size > 0 ? 'connecting' : 'disconnected';
  }

  /** The connected device, else the one of the latest session in this window. */
  get linkDevice(): SavedDevice | undefined {
    const id = this.session?.id ?? this.recent?.id;
    return this.devices.find(d => d.id === id);
  }

  get linkLabel(): string {
    return this.linkDevice?.name ?? this.label;
  }

  /** Reported by decky:// file access, which talks to any saved device on its own. */
  noteReachable(device: SavedDevice | undefined, reachable: boolean): void {
    const session = this.connectedDevice;
    if (!device || device.id === session?.id) {
      if (session && (reachable ? this.health.kind === 'unreachable' : this.health.kind !== 'unreachable')) void this.checkHealth();
      return;
    }
    this.setReachable(device.id, reachable);
  }

  /** Polls `/health` often while the session is unreachable so it recovers within seconds. */
  private scheduleHealth(): void {
    clearTimeout(this.healthTimer);
    if (!this.session) return;
    const ms = this.health.kind === 'unreachable' ? connectionTimings.retryMs : connectionTimings.healthPollMs;
    this.healthTimer = setTimeout(() => {
      void this.checkHealth().then(h => {
        // /health needs no pairing; the input settings route tells a rejected one apart.
        if (h.kind === 'ok' && this.session && this.statsLeases === 0) void this.refreshInput();
      }).finally(() => this.scheduleHealth());
    }, ms);
  }

  private async loadIdentityFlags(): Promise<void> {
    const flags = await Promise.all(this.devices.map(async d => [addressKey(d), !!(await this.identityFor(d))] as const));
    this.hasIdentity.clear();
    for (const [k, v] of flags) this.hasIdentity.set(k, v);
  }

  private fireStatus(): void {
    this.statusChanged.fire();
    this.changed.fire();
  }

  get connectedDevice(): SavedDevice | undefined {
    const s = this.session;
    return s && this.devices.find(d => d.id === s.id && d.host === s.host && d.port === s.port);
  }

  versionOf(id: string): string | undefined {
    return this.versions.get(id);
  }

  noteVersion(id: string, version: string | undefined): void {
    if (!version || this.versions.get(id) === version) return;
    this.versions.set(id, version);
    this.fireStatus();
  }

  statusOf(device: SavedDevice): DeviceStatus {
    const busy = this.busy.get(device.id);
    if (busy) return busy;
    if (this.connectedDevice?.id === device.id) return this.health.kind === 'unreachable' ? 'unreachable' : 'connected';
    if (this.unreachableIds.has(device.id)) return 'unreachable';
    return this.hasIdentity.get(addressKey(device)) ? 'disconnected' : 'unpaired';
  }

  setBusy(id: string, state: 'connecting' | 'pairing' | undefined): void {
    if (state) this.busy.set(id, state);
    else this.busy.delete(id);
    this.fireStatus();
  }

  private readonly pairingCodes = new Map<string, string>();

  pairingCodeOf(id: string): string | undefined {
    return this.pairingCodes.get(id);
  }

  setPairingCode(id: string, code: string | undefined): void {
    if (code) this.pairingCodes.set(id, code);
    else this.pairingCodes.delete(id);
    this.fireStatus();
  }

  setReachable(id: string, reachable: boolean): void {
    if (reachable === !this.unreachableIds.has(id)) return;
    if (reachable) this.unreachableIds.delete(id);
    else this.unreachableIds.add(id);
    // Re-probe unreachable devices so their rows and decky:// editors recover without a manual refresh.
    if (this.unreachableIds.size === 0) {
      clearInterval(this.probeTimer);
      this.probeTimer = undefined;
    } else {
      this.probeTimer ??= setInterval(() => void this.probeAll([...this.unreachableIds]), connectionTimings.healthPollMs);
    }
    this.fireStatus();
  }

  /** Marks devices that do not answer `/health` so the device list can show them as unreachable. */
  async probeAll(ids?: string[]): Promise<void> {
    const todo = this.devices.filter(d => d.id !== this.connectedDevice?.id && (!ids || ids.includes(d.id)));
    await Promise.all(todo.map(async d => {
      try {
        this.noteVersion(d.id, (await new DeckyClient(d).health(3000)).version);
        this.setReachable(d.id, true);
      } catch {
        this.setReachable(d.id, false);
      }
    }));
  }

  /** Starts a session with the active device, which must already be paired. */
  async markConnected(id: string): Promise<void> {
    const d = this.activeDevice;
    if (!d || d.id !== id) throw new Error('only the active device can be connected');
    this.session = { ...d };
    this.recent = this.session;
    this.unreachableIds.delete(id);
    this.health = { kind: 'unknown' };
    this.rejected = false;
    this.scheduleHealth();
    await this.ctx.globalState.update(SESSION_KEY, id);
    this.fireStatus();
    void this.checkHealth();
    void this.refreshInput();
  }

  async disconnect(): Promise<void> {
    if (!this.session) return;
    this.endSession();
    this.fireStatus();
  }

  private endSession(): void {
    this.session = undefined;
    clearTimeout(this.healthTimer);
    this.healthTimer = undefined;
    void this.ctx.globalState.update(SESSION_KEY, undefined);
  }

  /** The device connected when the window last closed, for a silent reconnect. */
  get lastSessionDevice(): SavedDevice | undefined {
    const id = this.ctx.globalState.get<string>(SESSION_KEY);
    return id ? this.devices.find(d => d.id === id) : undefined;
  }

  watchStats(): vscode.Disposable {
    if (this.statsLeases++ === 0) {
      this.statsTimer = setInterval(() => void this.pollStats(), STATS_POLL_MS);
      void this.pollStats();
    }
    let released = false;
    return new vscode.Disposable(() => {
      if (released) return;
      released = true;
      if (--this.statsLeases === 0) {
        clearInterval(this.statsTimer);
        this.statsTimer = undefined;
        if (this.stats || this.statsError) {
          this.stats = undefined;
          this.statsError = undefined;
          this.changed.fire();
        }
      }
    });
  }

  /** Errors other than 404 keep the last known state; health polling reports reachability. */
  async refreshInput(): Promise<InputState | undefined> {
    const client = this.authedClient();
    if (!client) return undefined;
    const gen = this.generation;
    let next: InputState;
    try {
      next = await client.getInputSettings();
    } catch (e) {
      if (gen === this.generation && isRejection(e)) this.setRejected(true);
      if (!(e instanceof HttpError && e.status === 404)) return this.input;
      next = 'unsupported';
    }
    if (gen !== this.generation) return next;
    this.setRejected(false);
    this.setInput(next);
    return next;
  }

  async setInputEnabled(enabled: boolean): Promise<InputSettings> {
    const client = this.authedClient();
    if (!client) throw new Error('not paired');
    const gen = this.generation;
    const next = await client.setInputEnabled(enabled);
    if (gen === this.generation) this.setInput(next);
    return next;
  }

  private setInput(next: InputState): void {
    if (JSON.stringify(next) === JSON.stringify(this.input)) return;
    this.input = next;
    this.changed.fire();
  }

  private async pollStats(): Promise<void> {
    const client = this.authedClient();
    if (!client || !this.session) return;
    void this.refreshInput();
    const gen = this.generation;
    try {
      const stats = await client.streamStats();
      if (gen !== this.generation || this.statsLeases === 0) return;
      this.stats = stats;
      this.statsError = stats.error ?? undefined;
      this.setRejected(false);
      this.changed.fire();
      if (this.health.kind !== 'ok') void this.checkHealth();
    } catch (e) {
      if (gen !== this.generation || this.statsLeases === 0) return;
      this.stats = undefined;
      this.statsError = describeError(e);
      if (isRejection(e)) this.setRejected(true);
      this.changed.fire();
      if (isConnectionError(e)) this.setHealth({ kind: 'unreachable', error: this.statsError });
    }
  }

  /** The active device's stored pairing, read fresh from secret storage. */
  identity(): Promise<Identity | undefined> {
    return this.identityFor(this.address);
  }

  private proxyTarget(): ProxyTarget | undefined {
    return this.cachedIdentity ? { ...this.address, identity: this.cachedIdentity } : undefined;
  }

  unauthenticatedClient(): DeckyClient {
    return new DeckyClient(this.address);
  }

  authedClient(): DeckyClient | undefined {
    return this.cachedIdentity ? new DeckyClient(this.address, this.cachedIdentity) : undefined;
  }

  /** The connected device's client; offers to connect (and returns undefined) when there is none. */
  async client(): Promise<DeckyClient | undefined> {
    if (!this.connectedDevice) {
      const d = this.activeDevice;
      const connectTo = d ? `Connect to ${d.name}` : undefined;
      const choice = await vscode.window.showWarningMessage(
        'Decky Toolkit: not connected to a device.', ...(connectTo ? [connectTo] : []), 'Choose device');
      if (choice && choice === connectTo) await vscode.commands.executeCommand('decky-toolkit.connect', d!.id);
      else if (choice === 'Choose device') await vscode.commands.executeCommand('decky-toolkit.switchDevice');
    }
    return this.connectedDevice ? this.authedClient() : undefined;
  }

  dispose(): void {
    clearInterval(this.statsTimer);
    clearTimeout(this.healthTimer);
    clearInterval(this.probeTimer);
    this.proxy.stop();
    this.disposables.forEach(d => d.dispose());
  }
}

const LINK_SUFFIX: Record<LinkState, string> = {
  connecting: 'connecting…', connected: '', unreachable: 'connection lost', rejected: 'pairing rejected', disconnected: 'disconnected',
};

/** Short state for titles and view descriptions; empty while connected. */
export function linkSuffix(link: LinkState | undefined): string {
  return link ? LINK_SUFFIX[link] : '';
}

/** One explanation per state, shared by the screen panel, the preview and the log channels. */
export function linkMessage(conn: ConnectionState): string {
  const name = conn.linkLabel;
  switch (conn.link) {
    case 'connecting': return `Connecting to ${name}…`;
    case 'unreachable': return `Lost connection to ${name}.\nReconnecting as soon as it answers again…`;
    case 'rejected': return `${name} no longer accepts this editor.\nReconnect to continue; the device asks you to approve this editor again.`;
    case 'disconnected': return `Disconnected from ${name}.\nReconnect from the Devices view or the Reconnect action.`;
    default: return '';
  }
}

function addressKey({ host, port }: DeviceAddress): string {
  return `${host}:${port}`;
}

function secretKeyFor(address: DeviceAddress): string {
  return IDENTITY_PREFIX + addressKey(address);
}

function parseIdentity(raw: string | undefined): Identity | undefined {
  if (!raw) return undefined;
  try {
    const x = JSON.parse(raw) as Partial<Identity>;
    if (typeof x.key === 'string' && typeof x.cert === 'string' && typeof x.serverCert === 'string') return x as Identity;
  } catch {
    // not ours; treated as unpaired
  }
  return undefined;
}

export function newDeviceId(): string {
  return randomBytes(6).toString('hex');
}

/** Proxy base URL as the webview must address it (remote/web hosts rewrite loopback URLs). */
export async function externalProxyBase(conn: Connection): Promise<{ base: string; external: string }> {
  const base = await conn.proxy.start();
  const external = (await vscode.env.asExternalUri(vscode.Uri.parse(base))).toString(true).replace(/\/$/, '');
  return { base, external };
}
