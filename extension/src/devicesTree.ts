import * as vscode from 'vscode';
import type { ConnectionState, SavedDevice } from './connection';
import { STATUS_ICON, statusLabel } from './devices';

const DEFAULT_PORT = 8765;

export class DeviceNode extends vscode.TreeItem {
  device?: SavedDevice;
}

/**
 * One row per saved device; the row is also the connection state, so nothing about the device is
 * repeated elsewhere. The name is left out when it is just the host.
 */
export function deviceRow(conn: ConnectionState, d: SavedDevice): DeviceNode {
  const status = conn.statusOf(d);
  const session = conn.connectedDevice?.id === d.id;
  const address = `${d.host}:${d.port}`;
  const nameIsHost = d.name === d.host;
  const n = new DeviceNode(nameIsHost && d.port === DEFAULT_PORT ? d.host : nameIsHost ? address : d.name);
  n.id = `deck:${d.id}`;
  n.device = d;
  n.description = nameIsHost ? statusLabel(status) : `${address} · ${statusLabel(status)}`;
  const color = status === 'connected' ? 'testing.iconPassed' : status === 'unreachable' ? 'problemsWarningIcon.foreground' : undefined;
  n.iconPath = new vscode.ThemeIcon(STATUS_ICON[status], color ? new vscode.ThemeColor(color) : undefined);
  const busy = status === 'connecting' || status === 'pairing';
  n.contextValue = busy ? 'deck.busy' : session ? 'deck.session' : status === 'unpaired' ? 'deck.unpaired' : 'deck.paired';
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**${d.name}** · ${address}\n\n`);
  const h = conn.health;
  if (session && h.kind === 'ok') md.appendMarkdown(`Connected · ${h.health.name} ${h.health.version}, API v${h.health.api_version}\n\n`);
  else if (session && h.kind === 'unreachable') md.appendMarkdown(`Connected, but not answering: ${h.error}\n\n`);
  else md.appendMarkdown(`${statusLabel(status)}${busy ? '' : status === 'unpaired' ? ' · click to pair and connect' : ' · click to connect'}\n\n`);
  n.tooltip = md;
  if (!session && !busy) n.command = { command: 'decky-mcp.connect', title: 'Connect', arguments: [d.id] };
  return n;
}

export class DevicesTreeProvider implements vscode.TreeDataProvider<DeviceNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly sub: vscode.Disposable;

  constructor(private readonly conn: ConnectionState) {
    this.sub = conn.onDidChangeStatus(() => this.refresh());
  }

  refresh(): void {
    this.changed.fire(undefined);
  }

  getTreeItem(node: DeviceNode): vscode.TreeItem {
    return node;
  }

  getChildren(node?: DeviceNode): DeviceNode[] {
    if (node) return [];
    // Empty list → viewsWelcome "Add a Decky device".
    return this.conn.devices.map(d => deviceRow(this.conn, d));
  }

  dispose(): void {
    this.sub.dispose();
    this.changed.dispose();
  }
}
