import * as vscode from 'vscode';
import type { ConnectionState, SavedDevice } from './connection';
import { STATUS_ICON, statusLabel } from './devices';
import type { DeviceDiscovery } from './discovery';
import { DiscoveryNode, discoveryChildren, discoveryGroup } from './discoveryTree';

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
  const code = status === 'pairing' ? conn.pairingCodeOf?.(d.id) : undefined;
  const rejected = session && status === 'connected' && conn.rejected;
  const label = code ? `waiting for approval · code ${code}` : rejected ? 'pairing rejected' : statusLabel(status);
  const version = conn.versionOf?.(d.id);
  const versioned = version ? `v${version} · ${label}` : label;
  n.description = nameIsHost ? versioned : `${address} · ${versioned}`;
  const color = rejected ? 'problemsErrorIcon.foreground' : status === 'connected' ? 'testing.iconPassed'
    : status === 'unreachable' ? 'problemsWarningIcon.foreground' : undefined;
  n.iconPath = new vscode.ThemeIcon(rejected ? 'key' : STATUS_ICON[status], color ? new vscode.ThemeColor(color) : undefined);
  const busy = status === 'connecting' || status === 'pairing';
  n.contextValue = busy ? 'deck.busy' : session ? 'deck.session' : status === 'unpaired' ? 'deck.unpaired' : 'deck.paired';
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**${d.name}** · ${address}${version ? ` · Decky Toolkit ${version}` : ''}\n\n`);
  const h = conn.health;
  if (rejected) md.appendMarkdown('The device no longer accepts this editor · click to reconnect; the device asks you to approve this editor again\n\n');
  else if (session && h.kind === 'ok') md.appendMarkdown(`Connected · ${h.health.name} ${h.health.version}, API v${h.health.api_version}\n\n`);
  else if (session && h.kind === 'unreachable') md.appendMarkdown(`Lost connection: ${h.error}. Reconnecting as soon as it answers\n\n`);
  else md.appendMarkdown(`${label}${busy ? '' : status === 'unpaired' ? ' · click to pair and connect' : ' · click to connect'}\n\n`);
  n.tooltip = md;
  if (!session && !busy) n.command = { command: 'decky-toolkit.connect', title: 'Connect', arguments: [d.id] };
  else if (rejected) n.command = { command: 'decky-toolkit.reconnect', title: 'Reconnect' };
  return n;
}

type Node = DeviceNode | DiscoveryNode;

export class DevicesTreeProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly subs: vscode.Disposable[];

  constructor(private readonly conn: ConnectionState, private readonly discovery?: DeviceDiscovery) {
    this.subs = [conn.onDidChangeStatus(() => this.refresh())];
    if (discovery) this.subs.push(discovery.onDidChangeState(() => this.refresh()), discovery.onDidChange(() => this.refresh()));
  }

  refresh(): void {
    this.changed.fire(undefined);
  }

  getTreeItem(node: Node): vscode.TreeItem {
    return node;
  }

  getChildren(node?: Node): Node[] {
    if (node) return (node as DiscoveryNode).group && this.discovery ? discoveryChildren(this.discovery) : [];
    const rows: Node[] = this.conn.devices.map(d => deviceRow(this.conn, d));
    if (this.discovery?.enabled) rows.push(discoveryGroup(this.discovery));
    return rows;
  }

  dispose(): void {
    this.subs.forEach(s => s.dispose());
    this.changed.dispose();
  }
}
