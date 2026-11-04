import * as vscode from 'vscode';
import { DeckyClient, DeviceAddress } from './client';
import { DeviceProxy, ProxyTarget } from './proxy';

export class Connection implements vscode.Disposable {
  private cachedToken?: string;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  readonly proxy = new DeviceProxy(() => this.proxyTarget());
  private readonly disposables: vscode.Disposable[] = [this.changed];

  constructor(private readonly ctx: vscode.ExtensionContext) {
    this.disposables.push(
      ctx.secrets.onDidChange(e => { if (e.key === this.secretKey) void this.refresh(); }),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('decky-mcp.host') || e.affectsConfiguration('decky-mcp.port')) void this.refresh();
      }),
    );
  }

  get address(): DeviceAddress {
    const cfg = vscode.workspace.getConfiguration('decky-mcp');
    return { host: cfg.get<string>('host', '10.0.70.18').trim(), port: cfg.get<number>('port', 8765) };
  }

  get label(): string {
    const { host, port } = this.address;
    return port === 8765 ? host : `${host}:${port}`;
  }

  private get secretKey(): string {
    const { host, port } = this.address;
    return `decky-mcp.token:${host}:${port}`;
  }

  get paired(): boolean {
    return !!this.cachedToken;
  }

  async refresh(): Promise<void> {
    this.cachedToken = await this.ctx.secrets.get(this.secretKey);
    this.proxy.resetUpstreams();
    this.changed.fire();
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
    this.proxy.stop();
    this.disposables.forEach(d => d.dispose());
  }
}
