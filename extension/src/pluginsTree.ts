import * as vscode from 'vscode';
import type { PluginInfo } from './api';
import { DeckyClient, describeError } from './client';
import type { ConnectionState } from './connection';

export class PluginNode extends vscode.TreeItem {
  constructor(readonly info: PluginInfo) {
    super(info.name ?? info.dir);
    this.id = `plugin:${info.dir}`;
    this.description = `${info.version ?? '?'} · ${info.dir}`;
    this.iconPath = new vscode.ThemeIcon(info.has_backend ? 'extensions' : 'symbol-file');
    this.contextValue = 'plugin';
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${info.name ?? info.dir}**${info.author ? ` by ${info.author}` : ''}\n\n`);
    md.appendMarkdown(`- dir: \`${info.dir}\`\n`);
    md.appendMarkdown(`- flags: ${info.flags?.length ? info.flags.join(', ') : 'none'}\n`);
    md.appendMarkdown(`- api_version: ${info.api_version ?? '?'}\n`);
    md.appendMarkdown(`- has_backend: ${info.has_backend ?? '?'}\n`);
    this.tooltip = md;
  }
}

export class PluginsTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly sub: vscode.Disposable;

  constructor(private readonly conn: ConnectionState) {
    this.sub = conn.onDidChangeTarget(() => this.refresh());
  }

  refresh(): void {
    this.changed.fire(undefined);
  }

  getTreeItem(item: vscode.TreeItem): vscode.TreeItem {
    return item;
  }

  async getChildren(item?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (item) return [];
    const client = this.conn.connectedDevice && this.conn.authedClient();
    if (!client) return [];
    return loadPluginItems(client);
  }

  dispose(): void {
    this.sub.dispose();
    this.changed.dispose();
  }
}

export async function loadPluginItems(client: DeckyClient): Promise<vscode.TreeItem[]> {
  try {
    const plugins = await client.listPlugins();
    if (plugins.length === 0) return [placeholder('No plugins installed', 'info')];
    return plugins
      .slice()
      .sort((a, b) => (a.name ?? a.dir).localeCompare(b.name ?? b.dir))
      .map(p => new PluginNode(p));
  } catch (e) {
    const p = placeholder(`Could not load plugins: ${describeError(e)}`, 'warning');
    p.tooltip = 'Click to retry';
    p.command = { command: 'decky-mcp.refreshPlugins', title: 'Retry' };
    return [p];
  }
}

export function placeholder(label: string, icon: string): vscode.TreeItem {
  const t = new vscode.TreeItem(label);
  t.iconPath = new vscode.ThemeIcon(icon);
  t.contextValue = 'placeholder';
  return t;
}
