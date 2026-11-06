import * as vscode from 'vscode';
import { Connection, SavedDevice, newDeviceId } from './connection';
import { confirmReplace, replaceWith } from './devices';
import { DEFAULT_PORT, DeviceDiscovery, DiscoveredDevice } from './discovery';

export class DiscoveryNode extends vscode.TreeItem {
  found?: DiscoveredDevice;
  group?: true;
}

export function discoveryGroup(discovery: DeviceDiscovery): DiscoveryNode {
  const n = new DiscoveryNode('On this network', vscode.TreeItemCollapsibleState.Expanded);
  n.id = 'discovery';
  n.group = true;
  n.contextValue = 'discovery.group';
  const count = discovery.devices.length;
  n.iconPath = new vscode.ThemeIcon(discovery.scanning ? 'loading~spin' : 'radio-tower');
  n.description = discovery.scanning ? 'searching…' : discovery.lastScan ? (count ? `${count} found` : 'none found') : undefined;
  const last = discovery.lastScan;
  n.tooltip = last
    ? `Decky Toolkit devices on the local network (mDNS and ${last.subnets.join(', ') || 'no local subnet'}), searched in ${(last.ms / 1000).toFixed(1)} s`
    : 'Decky Toolkit devices on the local network';
  return n;
}

export function foundRow(d: DiscoveredDevice): DiscoveryNode {
  const n = new DiscoveryNode(d.name);
  n.id = `found:${d.key}`;
  n.found = d;
  n.contextValue = 'deck.found';
  n.iconPath = new vscode.ThemeIcon('vm');
  const address = d.port === DEFAULT_PORT ? d.host : d.key;
  n.description = `${address} · v${d.version}`;
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**${d.hostname ?? d.name}** · ${d.key}\n\n`);
  md.appendMarkdown(`Decky Toolkit ${d.version}, API ${d.api.join(', ') || 'none'}${d.os ? ` · ${d.os}` : ''}\n\n`);
  md.appendMarkdown('Not paired · click to add it and pair\n\n');
  n.tooltip = md;
  n.command = { command: 'decky-toolkit.connectFound', title: 'Connect', arguments: [d.key] };
  return n;
}

export function discoveryChildren(discovery: DeviceDiscovery): DiscoveryNode[] {
  const add = new DiscoveryNode('Add a device by address…');
  add.id = 'discovery:add';
  add.contextValue = 'discovery.add';
  add.iconPath = new vscode.ThemeIcon('add');
  add.command = { command: 'decky-toolkit.addDevice', title: 'Add device…' };
  return [...discovery.devices.map(foundRow), add];
}

/**
 * Connects to a found device, which starts pairing; one that is not saved replaces the saved device after
 * a confirmation.
 */
export async function connectFound(conn: Connection, discovery: DeviceDiscovery, arg: unknown): Promise<void> {
  const key = typeof arg === 'string' ? arg : (arg as DiscoveryNode | undefined)?.found?.key;
  const d = key ? discovery.find(key) : undefined;
  if (!d) throw new Error('that device is no longer in the network list; search again.');
  let saved: SavedDevice | undefined = conn.devices.find(x => x.host === d.host && x.port === d.port);
  if (!saved) {
    if (!(await confirmReplace(conn))) return;
    saved = { id: newDeviceId(), name: d.name, host: d.host, port: d.port };
    await replaceWith(conn, saved);
  }
  await vscode.commands.executeCommand('decky-toolkit.connect', saved.id);
}

export async function searchNetwork(discovery: DeviceDiscovery): Promise<void> {
  if (!discovery.enabled) {
    const on = await vscode.window.showInformationMessage('Decky Toolkit: network discovery is turned off.', 'Turn on');
    if (on !== 'Turn on') return;
    await vscode.workspace.getConfiguration('decky-toolkit').update('discovery.enabled', true, vscode.ConfigurationTarget.Global);
  }
  await discovery.rescan(true);
}
