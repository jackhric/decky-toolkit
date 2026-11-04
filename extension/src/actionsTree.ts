import * as vscode from 'vscode';
import type { ConnectionState } from './connection';
import { PluginFolder, findPluginFolders, pluginDirName } from './deploy';
import { viewerUrl } from './devices';

/** Argument the Plugin group passes to reload/logs: resolve the dir from the workspace, not the Deck. */
export const WORKSPACE_PLUGIN = { workspacePlugin: true } as const;

export class ActionNode extends vscode.TreeItem {
  children?: ActionNode[];
}

function group(id: string, label: string, icon: string, expanded: boolean, children: ActionNode[]): ActionNode {
  const n = new ActionNode(label, expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
  // Stable ids let VS Code keep the user's collapse state across the refresh every stats poll causes.
  n.id = `group.${id}`;
  n.iconPath = new vscode.ThemeIcon(icon);
  n.contextValue = `group.${id}`;
  n.children = children;
  return n;
}

function leaf(id: string, label: string, icon: string, command: string, args?: unknown[]): ActionNode {
  const n = new ActionNode(label);
  n.id = `action.${id}`;
  n.iconPath = new vscode.ThemeIcon(icon);
  n.contextValue = 'action';
  n.command = { command, title: label, arguments: args };
  return n;
}

export function screenDescription(conn: ConnectionState): string {
  if (conn.health.kind === 'unreachable') return 'offline';
  if (conn.statsError) return conn.statsError;
  const s = conn.stats;
  if (!s) return '';
  if (!s.running) return 'idle';
  return `${Math.round(s.fps)} fps · ${(s.kbps / 1000).toFixed(1)} Mbps`;
}

export class ActionsTreeProvider implements vscode.TreeDataProvider<ActionNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly subs: vscode.Disposable[];
  // Cached because the tree refreshes with every stats poll.
  private plugins?: Promise<PluginFolder[]>;

  constructor(private readonly conn: ConnectionState) {
    const watcher = vscode.workspace.createFileSystemWatcher('**/plugin.json');
    const rescan = () => this.refresh();
    this.subs = [
      conn.onDidChange(() => this.changed.fire(undefined)),
      vscode.workspace.onDidChangeWorkspaceFolders(rescan),
      vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('decky-mcp.pluginDirName')) rescan(); }),
      watcher, watcher.onDidCreate(rescan), watcher.onDidDelete(rescan), watcher.onDidChange(rescan),
    ];
  }

  refresh(): void {
    this.plugins = undefined;
    this.changed.fire(undefined);
  }

  getTreeItem(node: ActionNode): vscode.TreeItem {
    return node;
  }

  async getChildren(node?: ActionNode): Promise<ActionNode[]> {
    if (node) return node.children ?? [];
    const d = this.conn.connectedDevice;
    if (!d) return [];
    this.plugins ??= findPluginFolders();
    const plugins = await this.plugins;

    const screen = group('screen', 'Screen', 'device-desktop', true, [
      leaf('openScreen', 'Open screen panel', 'window', 'decky-mcp.openScreen'),
      leaf('openViewer', 'Open viewer in browser', 'link-external', 'decky-mcp.openViewer'),
      leaf('snapshot', 'Snapshot to file', 'device-camera', 'decky-mcp.snapshot'),
    ]);
    screen.description = screenDescription(this.conn);
    screen.tooltip = 'Live Deck display';
    screen.children![1].tooltip = `Opens ${viewerUrl(d)} in your browser. The browser is paired separately: press "Pair a browser" ` +
      'in the Deck\'s Decky-MCP panel, unless it still has the cookie from an earlier pairing.';
    screen.children![2].tooltip = 'Save the current frame (/frame.jpg) as a JPEG';

    return [
      screen,
      this.pluginGroup(plugins),
      group('loader', 'Loader', 'server', true, [
        leaf('restartLoader', 'Restart loader', 'debug-restart', 'decky-mcp.restartLoader'),
        leaf('loaderLogs', 'Show loader logs', 'output', 'decky-mcp.loaderLogs'),
        leaf('installZip', 'Install plugin zip…', 'file-zip', 'decky-mcp.installZip'),
      ]),
      group('steam', 'Steam', 'game', false, [
        leaf('evaluate', 'Evaluate JS in Steam UI', 'terminal', 'decky-mcp.evaluate'),
        leaf('toast', 'Toast on Deck', 'bell', 'decky-mcp.toast'),
      ]),
      group('mcp', 'MCP', 'server-process', false, [
        leaf('mcpConfig', 'Write MCP config for this workspace', 'json', 'decky-mcp.writeMcpConfig'),
        leaf('copyMcpUrl', 'Copy MCP URL', 'link', 'decky-mcp.copyMcpUrl'),
        leaf('copyToken', 'Copy token', 'key', 'decky-mcp.copyToken'),
      ]),
    ];
  }

  private pluginGroup(plugins: PluginFolder[]): ActionNode {
    const args = [WORKSPACE_PLUGIN];
    const children = [
      leaf('deploy', 'Deploy', 'cloud-upload', 'decky-mcp.deploy'),
      leaf('reloadPlugin', 'Reload backend', 'refresh', 'decky-mcp.reloadPlugin', args),
      leaf('pluginLogs', 'Show plugin logs', 'output', 'decky-mcp.pluginLogs', args),
    ];
    const g = group('plugin', 'Plugin', 'package', true, children);
    if (plugins.length === 0) {
      g.description = 'no plugin.json in workspace';
      g.tooltip = 'Open a Decky plugin folder (one with plugin.json) to deploy, reload or tail it';
      for (const c of children) {
        // Still clickable so the command can explain what is missing.
        c.description = 'needs a plugin folder';
        c.iconPath = new vscode.ThemeIcon((c.iconPath as vscode.ThemeIcon).id, new vscode.ThemeColor('disabledForeground'));
        c.contextValue = 'action.disabled';
      }
      return g;
    }
    const dirs = plugins.map(pluginDirName);
    g.description = dirs.join(', ');
    g.tooltip = plugins.length === 1
      ? `${plugins[0].name} from ${plugins[0].folder.uri.fsPath}, deployed to ~/homebrew/plugins/${dirs[0]}`
      : 'Several workspace folders contain a plugin.json; each action asks which one';
    return g;
  }

  dispose(): void {
    this.subs.forEach(s => s.dispose());
    this.changed.dispose();
  }
}
