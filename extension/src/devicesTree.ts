import * as vscode from 'vscode';
import type { ConnectionState, SavedDevice } from './connection';
import { ACTIONS, action, screenNode } from './deviceTree';
import { STATUS_ICON, statusLabel, viewerUrl } from './devices';
import { loadPluginItems, placeholder } from './pluginsTree';

const DEFAULT_PORT = 8765;

type Group = 'plugins' | 'actions' | 'settings';

export class DeckNode extends vscode.TreeItem {
  device?: SavedDevice;
  group?: Group;
  children?: vscode.TreeItem[];
}

/**
 * One row per saved device; the row is also the connection state, so nothing about the device is
 * repeated elsewhere. The name is left out when it is just the host.
 */
export function deviceRow(conn: ConnectionState, d: SavedDevice, collapsible = vscode.TreeItemCollapsibleState.None): DeckNode {
  const status = conn.statusOf(d);
  const session = conn.connectedDevice?.id === d.id;
  const address = `${d.host}:${d.port}`;
  const nameIsHost = d.name === d.host;
  const n = new DeckNode(nameIsHost && d.port === DEFAULT_PORT ? d.host : nameIsHost ? address : d.name, collapsible);
  // The id includes the session flag so the connected device expands when it connects.
  n.id = `deck:${d.id}:${session ? 'session' : 'idle'}`;
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

/** Layout `devices-first`: the saved Decks, nothing else. */
export class DevicesTreeProvider implements vscode.TreeDataProvider<DeckNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly sub: vscode.Disposable;

  constructor(private readonly conn: ConnectionState) {
    this.sub = conn.onDidChangeStatus(() => this.refresh());
  }

  refresh(): void {
    this.changed.fire(undefined);
  }

  getTreeItem(node: DeckNode): vscode.TreeItem {
    return node;
  }

  getChildren(node?: DeckNode): DeckNode[] {
    if (node) return [];
    // Empty list → viewsWelcome "Add a Deck".
    return this.conn.devices.map(d => deviceRow(this.conn, d));
  }

  dispose(): void {
    this.sub.dispose();
    this.changed.dispose();
  }
}

function group(id: Group, label: string, icon: string, expanded: boolean): DeckNode {
  const n = new DeckNode(label, expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
  n.id = `group.${id}`;
  n.group = id;
  n.iconPath = new vscode.ThemeIcon(icon);
  n.contextValue = `group.${id}`;
  return n;
}

/** Layout `unified`: every Deck in one tree; the connected one expands to its tools. */
export class UnifiedTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly subs: vscode.Disposable[];
  // Cached because the tree refreshes with every stats poll.
  private plugins?: Promise<vscode.TreeItem[]>;

  constructor(private readonly conn: ConnectionState) {
    this.subs = [
      conn.onDidChange(() => this.changed.fire(undefined)),
      conn.onDidChangeTarget(() => this.refreshPlugins()),
    ];
  }

  refresh(): void {
    this.plugins = undefined;
    this.changed.fire(undefined);
  }

  refreshPlugins(): void {
    this.refresh();
  }

  getTreeItem(node: vscode.TreeItem): vscode.TreeItem {
    return node;
  }

  async getChildren(node?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (!node) {
      return this.conn.devices.map(d => deviceRow(this.conn, d, this.conn.connectedDevice?.id === d.id
        ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed));
    }
    if (!(node instanceof DeckNode)) return [];
    if (node.group === 'plugins') return this.pluginItems();
    if (node.group) return node.children ?? [];
    const d = node.device;
    if (!d) return [];
    if (this.conn.connectedDevice?.id === d.id) {
      const settings = group('settings', 'Settings', 'settings-gear', false);
      settings.children = [
        action('edit', 'Edit', 'pencil', 'decky-mcp.editDevice', [d.id]),
        action('copyUrl', 'Copy viewer URL', 'copy', 'decky-mcp.copyViewerUrl', [d.id]),
        action('remove', 'Remove', 'trash', 'decky-mcp.removeDevice', [d.id]),
      ];
      settings.children[1].tooltip = viewerUrl(d);
      const actions = group('actions', 'Actions', 'tools', true);
      actions.children = ACTIONS.map(a => action(...a));
      return [screenNode(this.conn), group('plugins', 'Plugins', 'extensions', false), actions, settings];
    }
    const status = this.conn.statusOf(d);
    if (status === 'connecting' || status === 'pairing') return [placeholder(status === 'pairing' ? 'Pairing… see the notification' : 'Connecting…', 'loading~spin')];
    return [
      action(`connect:${d.id}`, status === 'unpaired' ? 'Connect (pairs first)' : 'Connect', 'plug', 'decky-mcp.connect', [d.id]),
      action(`edit:${d.id}`, 'Edit', 'pencil', 'decky-mcp.editDevice', [d.id]),
      action(`remove:${d.id}`, 'Remove', 'trash', 'decky-mcp.removeDevice', [d.id]),
    ];
  }

  private pluginItems(): Promise<vscode.TreeItem[]> {
    const client = this.conn.authedClient();
    if (!client) return Promise.resolve([]);
    this.plugins ??= loadPluginItems(client);
    return this.plugins;
  }

  dispose(): void {
    this.subs.forEach(s => s.dispose());
    this.changed.dispose();
  }
}
