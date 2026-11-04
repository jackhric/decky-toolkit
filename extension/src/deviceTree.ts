import * as vscode from 'vscode';
import type { ConnectionState, SavedDevice } from './connection';
import type { Layout } from './layout';

type Kind = 'devices' | 'device' | 'connection' | 'screen' | 'actions' | 'action';

export class DeviceNode extends vscode.TreeItem {
  children?: DeviceNode[];
  device?: SavedDevice;

  constructor(readonly kind: Kind, id: string, label: string, icon: string, collapsible = vscode.TreeItemCollapsibleState.None) {
    super(label, collapsible);
    this.id = id;
    this.iconPath = new vscode.ThemeIcon(icon);
    this.contextValue = kind;
  }
}

export function action(id: string, label: string, icon: string, command: string, args?: unknown[]): DeviceNode {
  const n = new DeviceNode('action', `action.${id}`, label, icon);
  n.command = { command, title: label, arguments: args };
  return n;
}

export const ACTIONS: [string, string, string, string][] = [
  ['deploy', 'Deploy plugin', 'cloud-upload', 'decky-mcp.deploy'],
  ['restart', 'Restart loader', 'debug-restart', 'decky-mcp.restartLoader'],
  ['reload', 'Reload plugin', 'refresh', 'decky-mcp.reloadPlugin'],
  ['loaderLogs', 'Loader logs', 'output', 'decky-mcp.loaderLogs'],
  ['pluginLogs', 'Plugin logs', 'list-flat', 'decky-mcp.pluginLogs'],
  ['evaluate', 'Evaluate JS in Steam UI', 'terminal', 'decky-mcp.evaluate'],
  ['toast', 'Toast on Deck', 'bell', 'decky-mcp.toast'],
  ['mcpConfig', 'Write MCP config', 'json', 'decky-mcp.writeMcpConfig'],
];

export function connectionDescription(conn: ConnectionState): string {
  if (!conn.paired) return 'Not paired';
  if (conn.tokenRejected) return 'Not paired (token rejected)';
  const h = conn.health;
  if (h.kind === 'ok') return `Connected · ${h.health.name} ${h.health.version} · api ${h.health.api_version}`;
  if (h.kind === 'unreachable') return 'Unreachable';
  return 'Connecting…';
}

export function screenDescription(conn: ConnectionState): string {
  if (conn.health.kind === 'unreachable') return 'offline';
  if (conn.statsError) return conn.statsError;
  const s = conn.stats;
  if (!s) return '';
  if (!s.running) return 'idle';
  return `${Math.round(s.fps)} fps · ${(s.kbps / 1000).toFixed(1)} Mbps`;
}

export function screenNode(conn: ConnectionState): DeviceNode {
  const n = new DeviceNode('screen', 'screen', 'Screen', 'device-desktop');
  n.description = screenDescription(conn);
  n.tooltip = 'Open the live Deck screen';
  n.command = { command: 'decky-mcp.openScreen', title: 'Open screen' };
  return n;
}

export class DeviceTreeProvider implements vscode.TreeDataProvider<DeviceNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<DeviceNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly sub: vscode.Disposable;

  constructor(private readonly conn: ConnectionState, private readonly layout: () => Layout = () => 'classic') {
    this.sub = conn.onDidChange(() => this.changed.fire(undefined));
  }

  refresh(): void {
    this.changed.fire(undefined);
  }

  getTreeItem(node: DeviceNode): vscode.TreeItem {
    return node;
  }

  getChildren(node?: DeviceNode): DeviceNode[] {
    if (node) return node.children ?? [];
    if (this.layout() !== 'classic') {
      if (!this.conn.connectedDevice) return [];
      return [screenNode(this.conn), ...ACTIONS.map(a => action(...a))];
    }
    // Empty while unpaired so the viewsWelcome content (pair buttons) is shown instead.
    if (!this.conn.paired) return [];
    return [this.devicesNode(), this.connectionNode(), screenNode(this.conn), this.actionsNode()];
  }

  private devicesNode(): DeviceNode {
    const n = new DeviceNode('devices', 'devices', 'Devices', 'vm', vscode.TreeItemCollapsibleState.Expanded);
    const active = this.conn.activeDevice;
    n.description = active?.name;
    n.children = this.conn.devices.map(d => {
      const isActive = d.id === active?.id;
      const c = new DeviceNode('device', `device:${d.id}`, d.name, isActive ? 'check' : 'device-mobile');
      c.device = d;
      c.contextValue = isActive ? 'device.active' : 'device';
      c.description = `${d.host}:${d.port}${isActive ? ' · active' : ''}`;
      c.tooltip = isActive ? `${d.name} (active)` : `Switch to ${d.name}`;
      if (!isActive) c.command = { command: 'decky-mcp.setActiveDevice', title: 'Set active', arguments: [d.id] };
      return c;
    });
    n.children.push(action('addDevice', 'Add device…', 'add', 'decky-mcp.addDevice'));
    return n;
  }

  private connectionNode(): DeviceNode {
    const { host, port } = this.conn.address;
    const h = this.conn.health;
    const icon = h.kind === 'ok' && !this.conn.tokenRejected ? 'plug' : h.kind === 'unreachable' ? 'debug-disconnect' : 'sync';
    const n = new DeviceNode('connection', 'connection', `${host}:${port}`, icon, vscode.TreeItemCollapsibleState.Collapsed);
    n.description = connectionDescription(this.conn);
    n.tooltip = h.kind === 'ok'
      ? `${h.health.name} ${h.health.version}, API v${h.health.api_version}, ${h.health.tools} tools`
      : h.kind === 'unreachable' ? h.error : undefined;
    n.children = [
      action('pair', 'Pair with device', 'key', 'decky-mcp.pair'),
      action('enterToken', 'Enter token', 'edit', 'decky-mcp.enterToken'),
      action('changeHost', 'Change host', 'server', 'decky-mcp.changeHost'),
      action('disconnect', 'Disconnect', 'debug-disconnect', 'decky-mcp.disconnect'),
    ];
    return n;
  }

  private actionsNode(): DeviceNode {
    const n = new DeviceNode('actions', 'actions', 'Actions', 'tools', vscode.TreeItemCollapsibleState.Expanded);
    n.children = ACTIONS.map(a => action(...a));
    return n;
  }

  dispose(): void {
    this.sub.dispose();
    this.changed.dispose();
  }
}
