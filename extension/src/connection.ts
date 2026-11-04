import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import type { Health, StreamStats } from './api';
import { DeckyClient, DeviceAddress, HttpError, describeError, isConnectionError } from './client';
import { DeviceProxy, ProxyTarget } from './proxy';

const STATS_POLL_MS = 5000;
const DEVICES_KEY = 'decky-mcp.devices';
const ACTIVE_KEY = 'decky-mcp.activeDevice';

export interface SavedDevice {
  id: string;
  name: string;
  host: string;
  port: number;
}

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
  readonly onDidChange: vscode.Event<void>;
  /** Host, port or token changed; unlike `onDidChange` not fired for health/stats updates. */
  readonly onDidChangeTarget: vscode.Event<void>;
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
  readonly proxy = new DeviceProxy(() => this.proxyTarget());
  private readonly disposables: vscode.Disposable[] = [this.changed, this.targetChanged];

  health: HealthState = { kind: 'unknown' };
  stats?: StreamStats;
  statsError?: string;
  tokenRejected = false;
  private statsLeases = 0;
  private statsTimer?: NodeJS.Timeout;
  // Bumped on every refresh so replies for a previous host/token are dropped.
  private generation = 0;

  constructor(private readonly ctx: vscode.ExtensionContext) {
    this.disposables.push(
      ctx.secrets.onDidChange(e => { if (e.key === this.secretKey) void this.refresh(); }),
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
  }

  private get secretKey(): string {
    return secretKeyFor(this.address);
  }

  get paired(): boolean {
    return !!this.cachedToken;
  }

  async refresh(): Promise<void> {
    const gen = ++this.generation;
    this.cachedToken = await this.ctx.secrets.get(this.secretKey);
    if (gen !== this.generation) return;
    this.proxy.resetUpstreams();
    this.health = { kind: 'unknown' };
    this.stats = undefined;
    this.statsError = undefined;
    this.tokenRejected = false;
    this.targetChanged.fire();
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
    this.changed.fire();
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

  private async pollStats(): Promise<void> {
    const client = this.authedClient();
    if (!client) return;
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
    await this.ctx.secrets.store(this.secretKey, token);
    await this.refresh();
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

  /** Returns undefined (after offering to pair) when no token is stored for the current device. */
  async client(): Promise<DeckyClient | undefined> {
    const token = await this.token();
    if (token) return new DeckyClient(this.address, token);
    const choice = await vscode.window.showWarningMessage(
      `Decky-MCP: not paired with ${this.label}.`, 'Pair with device', 'Enter token manually');
    if (choice === 'Pair with device') await vscode.commands.executeCommand('decky-mcp.pair');
    if (choice === 'Enter token manually') await vscode.commands.executeCommand('decky-mcp.enterToken');
    const after = await this.token();
    return after ? new DeckyClient(this.address, after) : undefined;
  }

  dispose(): void {
    clearInterval(this.statsTimer);
    this.proxy.stop();
    this.disposables.forEach(d => d.dispose());
  }
}

function secretKeyFor({ host, port }: DeviceAddress): string {
  return `decky-mcp.token:${host}:${port}`;
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
