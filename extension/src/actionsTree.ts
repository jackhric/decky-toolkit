import * as vscode from 'vscode';
import type { ConnectionState } from './connection';
import { DeployController, pluginSummary } from './deploy';
import { viewerUrl } from './devices';
import type { WorkspacePlugin } from './pluginDeploy';

export interface PluginSource {
  ready(): Promise<WorkspacePlugin[]>;
  readonly onDidChange: vscode.Event<void>;
}

/** Argument the Plugin group passes to reload/logs: resolve the dir from the workspace, not the device. */
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

  constructor(private readonly conn: ConnectionState, private readonly ws?: PluginSource) {
    this.subs = [
      conn.onDidChange(() => this.changed.fire(undefined)),
      vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('decky-toolkit.deploy')) this.refresh(); }),
    ];
    if (ws) this.subs.push(ws.onDidChange(() => this.refresh()));
  }

  refresh(): void {
    this.changed.fire(undefined);
  }

  getTreeItem(node: ActionNode): vscode.TreeItem {
    return node;
  }

  async getChildren(node?: ActionNode): Promise<ActionNode[]> {
    if (node) return node.children ?? [];
    const d = this.conn.connectedDevice;
    if (!d) return [];
    const plugins = this.ws ? await this.ws.ready() : [];

    const screen = group('screen', 'Screen', 'device-desktop', true, [
      leaf('openScreen', 'Open screen panel', 'window', 'decky-toolkit.openScreen'),
      leaf('openViewer', 'Open viewer in browser', 'link-external', 'decky-toolkit.openViewer'),
      leaf('snapshot', 'Snapshot to file', 'device-camera', 'decky-toolkit.snapshot'),
    ]);
    screen.description = screenDescription(this.conn);
    screen.tooltip = 'Live device display';
    screen.children![1].tooltip = `Opens ${viewerUrl(d)} in your browser. The browser is paired separately: it asks for access and you ` +
      'allow it in the device\'s Decky Toolkit panel, unless it still has the cookie from an earlier pairing.';
    screen.children![2].tooltip = 'Save the current frame (/frame.jpg) as a JPEG';

    return [
      screen,
      this.pluginGroup(plugins),
      group('loader', 'Loader', 'server', true, [
        leaf('restartLoader', 'Restart loader', 'debug-restart', 'decky-toolkit.restartLoader'),
        leaf('loaderLogs', 'Show loader logs', 'output', 'decky-toolkit.loaderLogs'),
        leaf('installZip', 'Install plugin zip…', 'file-zip', 'decky-toolkit.installZip'),
      ]),
      group('steam', 'Steam', 'game', false, [
        leaf('navigate', 'Navigate to…', 'compass', 'decky-toolkit.navigate'),
        leaf('openGameSaves', 'Open save data…', 'save', 'decky-toolkit.openGameSaves'),
        leaf('openPluginPanel', 'Open plugin panel…', 'extensions', 'decky-toolkit.openPluginPanel'),
        leaf('uiBack', 'Back', 'arrow-left', 'decky-toolkit.uiBack'),
        leaf('uiQuickAccess', 'Quick Access', 'layout-sidebar-right', 'decky-toolkit.uiQuickAccess'),
        leaf('uiCloseMenus', 'Close menus', 'close-all', 'decky-toolkit.uiCloseMenus'),
        leaf('evaluate', 'Evaluate JS in Steam UI', 'terminal', 'decky-toolkit.evaluate'),
        leaf('toast', 'Toast on device', 'bell', 'decky-toolkit.toast'),
      ]),
      group('mcp', 'MCP', 'server-process', false, [
        leaf('mcpConfig', 'Write MCP config for this workspace', 'json', 'decky-toolkit.writeMcpConfig'),
        leaf('copyMcpUrl', 'Copy MCP URL', 'link', 'decky-toolkit.copyMcpUrl'),
        leaf('copyToken', 'Copy token', 'key', 'decky-toolkit.copyToken'),
      ]),
    ];
  }

  private pluginGroup(plugins: WorkspacePlugin[]): ActionNode {
    const args = [WORKSPACE_PLUGIN];
    const auto = DeployController.autoDeployEnabled;
    const children = [
      leaf('deploy', 'Deploy', 'rocket', 'decky-toolkit.deploy'),
      leaf('deployFull', 'Deploy (full restart)', 'debug-restart', 'decky-toolkit.deployFull'),
      leaf('reloadPlugin', 'Reload backend', 'refresh', 'decky-toolkit.reloadPlugin', args),
      leaf('pluginLogs', 'Show plugin logs', 'output', 'decky-toolkit.pluginLogs', args),
      leaf('autoDeploy', `Auto-deploy on change: ${auto ? 'On' : 'Off'}`, auto ? 'sync' : 'sync-ignored', 'decky-toolkit.toggleAutoDeploy'),
    ];
    children[0].tooltip = 'Build if sources changed, install and reload only this plugin (no loader restart)';
    children[1].tooltip = 'Build if sources changed, install and restart Decky Loader (reloads the Steam UI)';
    children[4].tooltip = auto
      ? 'On: every change to dist/index.js, main.py or py_modules/**/*.py deploys (no build; keep `pnpm run watch` running). Click to turn off'
      : 'Off. Click to deploy automatically whenever dist/index.js, main.py or py_modules/**/*.py change';
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
    if (plugins.length === 1) {
      const [p] = plugins;
      g.description = pluginSummary(p);
      g.tooltip = `${p.name}${p.version ? ` ${p.version}` : ''} from ${p.root}, deployed to ~/homebrew/plugins/${p.dir}` +
        `${p.hasDebugFlag ? ' (debug flag: the loader\'s watcher reloads it after each install)' : ''}`;
    } else {
      g.description = plugins.map(pluginSummary).join(', ');
      g.tooltip = `Several plugins in the workspace (${plugins.map(p => `${p.name} → ${p.dir}`).join(', ')}); each action asks which one`;
    }
    return g;
  }

  dispose(): void {
    this.subs.forEach(s => s.dispose());
    this.changed.dispose();
  }
}
