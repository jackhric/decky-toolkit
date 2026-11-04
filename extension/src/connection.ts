import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import type { Health, InputSettings, StreamStats } from './api';
import { DeckyClient, DeviceAddress, HttpError, describeError, isConnectionError } from './client';
import { DeviceProxy, ProxyTarget } from './proxy';

const STATS_POLL_MS = 5000;
const DEVICES_KEY = 'decky-mcp.devices';
const ACTIVE_KEY = 'decky-mcp.activeDevice';
const SESSION_KEY = 'decky-mcp.connectedDevice';
const TOKEN_PREFIX = 'decky-mcp.token:';

/** Mutable so tests can shorten them. */
export const connectionTimings = { healthPollMs: 15000 };

export type DeviceStatus = 'unpaired' | 'disconnected' | 'connecting' | 'pairing' | 'connected' | 'unreachable';

export interface SavedDevice {
  id: string;
  name: string;
  host: string;
  port: number;
}

/** `unsupported`: the device answers 404 to `/input/settings` (plugin predates remote input). */
export type InputState = InputSettings | 'unsupported';

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
  readonly tokenRejected: boolean;
  readonly health: HealthState;
  readonly stats?: StreamStats;
  readonly statsError?: string;
  /** Undefined until the first `/input/settings` answer for the connected device. */
  readonly input?: InputState;
  readonly onDidChange: vscode.Event<void>;
  /** Host, port or token changed; unlike `onDidChange` not fired for health/stats updates. */
  readonly onDidChangeTarget: vscode.Event<void>;
  /** The device of the current session; stays set while it is briefly unreachable. */
  readonly connectedDevice: SavedDevice | undefined;
  readonly onDidChangeStatus: vscode.Event<void>;
  statusOf(device: SavedDevice): DeviceStatus;
  /** The code the device shows for a pairing request that is waiting for approval. */
  pairingCodeOf?(id: string): string | undefined;
  authedClient(): DeckyClient | undefined;
  /** Polls `/stream/stats` while at least one returned lease is undisposed. */
  watchStats(): vscode.Disposable;
}

export class Connection implements ConnectionState, vscode.Disposable {
  private cachedToken?: string;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly targetChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeTarget = this.targetChanged.event;
  private readonly statusChanged = new vscode.EventEmitter<void>();
  /** Some device's `statusOf` may have changed. */
  readonly onDidChangeStatus = this.statusChanged.event;
  readonly proxy = new DeviceProxy(() => this.proxyTarget());
  private readonly disposables: vscode.Disposable[] = [this.changed, this.targetChanged, this.statusChanged];

  health: HealthState = { kind: 'unknown' };
  stats?: StreamStats;
  statsError?: string;
  input?: InputState;
  tokenRejected = false;
  private statsLeases = 0;
  private statsTimer?: NodeJS.Timeout;
  // Bumped on every refresh so replies for a previous host/token are dropped.
  private generation = 0;
  private readonly hasToken = new Map<string, boolean>();
  private readonly busy = new Map<string, 'connecting' | 'pairing'>();
  private readonly unreachableIds = new Set<string>();
  private session?: SavedDevice;
  private healthTimer?: NodeJS.Timeout;

  constructor(private readonly ctx: vscode.ExtensionContext) {
    this.disposables.push(
      ctx.secrets.onDidChange(e => {
        if (e.key === this.secretKey) void this.refresh();
        else if (e.key.startsWith(TOKEN_PREFIX)) void this.loadTokenFlags().then(() => this.fireStatus());
      }),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('decky-mcp.host') || e.affectsConfiguration('decky-mcp.port')) void this.refresh();
      }),
    );
  }

  private get settingsAddress(): DeviceAddress {
    const cfg = vscode.workspace.getConfiguration('decky-mcp');
    return { host: cfg.get<string>('host', '10.0.70.18').trim(), port: cfg.get<number>('port', 8765) };
  }

  /** Seeds the device list from the host/port settings the first time the extension runs. */
  async initDevices(): Promise<void> {
    if (this.ctx.globalState.get<SavedDevice[]>(DEVICES_KEY) !== undefined) return;
    const { host, port } = this.settingsAddress;
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

  async tokenFor(address: DeviceAddress): Promise<string | undefined> {
    return this.ctx.secrets.get(secretKeyFor(address));
  }

  async deleteTokenFor(address: DeviceAddress): Promise<void> {
    await this.ctx.secrets.delete(secretKeyFor(address));
    this.hasToken.set(addressKey(address), false);
  }

  async setTokenFor(address: DeviceAddress, token: string): Promise<void> {
    await this.ctx.secrets.store(secretKeyFor(address), token);
    this.hasToken.set(addressKey(address), true);
    if (secretKeyFor(address) === this.secretKey) await this.refresh();
    else this.fireStatus();
  }

  private get secretKey(): string {
    return secretKeyFor(this.address);
  }

  get paired(): boolean {
    return !!this.cachedToken;
  }

  async refresh(): Promise<void> {
    const gen = ++this.generation;
    const token = await this.ctx.secrets.get(this.secretKey);
    await this.loadTokenFlags();
    if (gen !== this.generation) return;
    this.cachedToken = token;
    const s = this.session, a = this.activeDevice;
    if (s && !(a && token && a.id === s.id && a.host === s.host && a.port === s.port)) this.endSession();
    this.proxy.resetUpstreams();
    this.health = { kind: 'unknown' };
    this.stats = undefined;
    this.statsError = undefined;
    this.input = undefined;
    this.tokenRejected = false;
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
    if (gen === this.generation) this.setHealth(next);
    return next;
  }

  private setHealth(next: HealthState): void {
    if (JSON.stringify(next) === JSON.stringify(this.health)) return;
    this.health = next;
    if (this.session) this.statusChanged.fire();
    this.changed.fire();
  }

  private async loadTokenFlags(): Promise<void> {
    const flags = await Promise.all(this.devices.map(async d => [addressKey(d), !!(await this.tokenFor(d))] as const));
    this.hasToken.clear();
    for (const [k, v] of flags) this.hasToken.set(k, v);
  }

  private fireStatus(): void {
    this.statusChanged.fire();
    this.changed.fire();
  }

  get connectedDevice(): SavedDevice | undefined {
    const s = this.session;
    return s && this.devices.find(d => d.id === s.id && d.host === s.host && d.port === s.port);
  }

  statusOf(device: SavedDevice): DeviceStatus {
    const busy = this.busy.get(device.id);
    if (busy) return busy;
    if (this.connectedDevice?.id === device.id) return this.health.kind === 'unreachable' ? 'unreachable' : 'connected';
    if (this.unreachableIds.has(device.id)) return 'unreachable';
    return this.hasToken.get(addressKey(device)) ? 'disconnected' : 'unpaired';
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
    this.fireStatus();
  }

  /** Marks devices that do not answer `/health` so the device list can show them as unreachable. */
  async probeAll(): Promise<void> {
    await Promise.all(this.devices.filter(d => d.id !== this.connectedDevice?.id).map(async d => {
      try {
        await new DeckyClient(d).health(3000);
        this.setReachable(d.id, true);
      } catch {
        this.setReachable(d.id, false);
      }
    }));
  }

  /** Starts a session with the active device, which must already hold a token. */
  async markConnected(id: string): Promise<void> {
    const d = this.activeDevice;
    if (!d || d.id !== id) throw new Error('only the active device can be connected');
    this.session = { ...d };
    this.unreachableIds.delete(id);
    clearInterval(this.healthTimer);
    this.healthTimer = setInterval(() => void this.checkHealth(), connectionTimings.healthPollMs);
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
    clearInterval(this.healthTimer);
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
      if (!(e instanceof HttpError && e.status === 404)) return this.input;
      next = 'unsupported';
    }
    if (gen === this.generation) this.setInput(next);
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
    if (!client) return;
    if (this.session) void this.refreshInput();
    const gen = this.generation;
    try {
      const stats = await client.streamStats();
      if (gen !== this.generation || this.statsLeases === 0) return;
      this.stats = stats;
      this.statsError = stats.error ?? undefined;
      this.tokenRejected = false;
      this.changed.fire();
      if (this.health.kind !== 'ok') void this.checkHealth();
    } catch (e) {
      if (gen !== this.generation || this.statsLeases === 0) return;
      this.stats = undefined;
      this.statsError = describeError(e);
      this.tokenRejected = e instanceof HttpError && e.status === 401;
      this.changed.fire();
      if (isConnectionError(e)) this.setHealth({ kind: 'unreachable', error: this.statsError });
    }
  }

  async token(): Promise<string | undefined> {
    return this.ctx.secrets.get(this.secretKey);
  }

  async setToken(token: string): Promise<void> {
    await this.setTokenFor(this.address, token);
  }

  async clearToken(): Promise<void> {
    await this.ctx.secrets.delete(this.secretKey);
    await this.refresh();
  }

  private proxyTarget(): ProxyTarget | undefined {
    return this.cachedToken ? { ...this.address, token: this.cachedToken } : undefined;
  }

  unauthenticatedClient(): DeckyClient {
    return new DeckyClient(this.address);
  }

  authedClient(): DeckyClient | undefined {
    return this.cachedToken ? new DeckyClient(this.address, this.cachedToken) : undefined;
  }

  /** The connected device's client; offers to connect (and returns undefined) when there is none. */
  async client(): Promise<DeckyClient | undefined> {
    if (!this.connectedDevice) {
      const d = this.activeDevice;
      const connectTo = d ? `Connect to ${d.name}` : undefined;
      const choice = await vscode.window.showWarningMessage(
        'Decky-MCP: not connected to a device.', ...(connectTo ? [connectTo] : []), 'Choose device');
      if (choice && choice === connectTo) await vscode.commands.executeCommand('decky-mcp.connect', d!.id);
      else if (choice === 'Choose device') await vscode.commands.executeCommand('decky-mcp.switchDevice');
    }
    return this.connectedDevice ? this.authedClient() : undefined;
  }

  dispose(): void {
    clearInterval(this.statsTimer);
    clearInterval(this.healthTimer);
    this.proxy.stop();
    this.disposables.forEach(d => d.dispose());
  }
}

function addressKey({ host, port }: DeviceAddress): string {
  return `${host}:${port}`;
}

function secretKeyFor(address: DeviceAddress): string {
  return TOKEN_PREFIX + addressKey(address);
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
