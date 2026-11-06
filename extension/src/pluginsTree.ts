import * as vscode from 'vscode';
import type { PluginInfo } from '@decky-toolkit/client/api';
import { DeckyClient, describeError } from '@decky-toolkit/client/client';
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
  private readonly subs: vscode.Disposable[];
  private listed?: string;

  constructor(private readonly conn: ConnectionState) {
    this.subs = [
      conn.onDidChangeTarget(() => this.refresh()),
      conn.onDidReceiveEvent(e => {
        if (e.event !== 'plugins') return;
        // Every reconnect replays the list; only a different one needs a reload.
        const listed = JSON.stringify(e.data.plugins);
        if (this.listed !== undefined && listed !== this.listed) this.refresh();
        this.listed = listed;
      }),
    ];
  }

  refresh(): void {
    this.changed.fire(undefined);
  }

  getTreeItem(item: vscode.TreeItem): vscode.TreeItem {
    return item;
  }

  async getChildren(item?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (item) return [];
    const client = this.conn.link === 'connected' && this.conn.authedClient();
    if (!client) return [];
    return loadPluginItems(client);
  }

  dispose(): void {
    this.subs.forEach(s => s.dispose());
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
    p.command = { command: 'decky-toolkit.refreshPlugins', title: 'Retry' };
    return [p];
  }
}

export function placeholder(label: string, icon: string): vscode.TreeItem {
  const t = new vscode.TreeItem(label);
  t.iconPath = new vscode.ThemeIcon(icon);
  t.contextValue = 'placeholder';
  return t;
}
