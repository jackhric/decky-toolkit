import * as vscode from 'vscode';
import { Connection, SavedDevice, newDeviceId } from './connection';

const HOST_RE = /^(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.\-]+)$/;

function validateHost(v: string): string | undefined {
  const h = v.trim();
  if (!h) return 'Host is empty';
  if (h.includes('://') || h.includes('/')) return 'Enter only the IP or hostname, without http:// or a path';
  return HOST_RE.test(h) ? undefined : 'Not a valid IP address or hostname';
}

function validatePort(v: string): string | undefined {
  const n = Number(v.trim());
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? undefined : 'Port must be a number from 1 to 65535';
}

async function promptAddress(initial: { host: string; port: number }, title: string): Promise<{ host: string; port: number } | undefined> {
  const host = (await vscode.window.showInputBox({
    title, prompt: 'IP address or hostname of the Steam Deck', value: initial.host, ignoreFocusOut: true, validateInput: validateHost,
  }))?.trim();
  if (!host) return undefined;
  const port = (await vscode.window.showInputBox({
    title, prompt: 'Decky-MCP port', value: String(initial.port), ignoreFocusOut: true, validateInput: validatePort,
  }))?.trim();
  if (!port) return undefined;
  return { host, port: Number(port) };
}

/** Accepts a tree node, a device id or nothing (then the active device). */
function deviceFrom(conn: Connection, arg: unknown): SavedDevice | undefined {
  const id = typeof arg === 'string' ? arg : (arg as { device?: SavedDevice } | undefined)?.device?.id;
  return id ? conn.devices.find(d => d.id === id) : conn.activeDevice;
}

function duplicateOf(conn: Connection, host: string, port: number, exceptId?: string): SavedDevice | undefined {
  return conn.devices.find(d => d.id !== exceptId && d.host === host && d.port === port);
}

export async function addDevice(conn: Connection): Promise<void> {
  const title = 'Add Decky device';
  const addr = await promptAddress({ host: '', port: 8765 }, title);
  if (!addr) return;
  const dup = duplicateOf(conn, addr.host, addr.port);
  if (dup) throw new Error(`${addr.host}:${addr.port} is already saved as "${dup.name}".`);
  const name = (await vscode.window.showInputBox({
    title, prompt: 'Name for this device', value: addr.host, ignoreFocusOut: true,
    validateInput: v => (v.trim() ? undefined : 'Name is empty'),
  }))?.trim();
  if (!name) return;
  const device: SavedDevice = { id: newDeviceId(), name, ...addr };
  await conn.saveDevices([...conn.devices, device], device.id);
  const paired = !!(await conn.tokenFor(addr));
  if (paired) {
    void vscode.window.showInformationMessage(`Decky-MCP: switched to ${name} (already paired).`);
  } else {
    const choice = await vscode.window.showInformationMessage(`Decky-MCP: switched to ${name}.`, 'Pair with device', 'Enter token manually');
    if (choice === 'Pair with device') await vscode.commands.executeCommand('decky-mcp.pair');
    if (choice === 'Enter token manually') await vscode.commands.executeCommand('decky-mcp.enterToken');
  }
}

export async function editDevice(conn: Connection, arg?: unknown): Promise<void> {
  const d = deviceFrom(conn, arg);
  if (!d) return addDevice(conn);
  const title = `Edit ${d.name}`;
  const name = (await vscode.window.showInputBox({
    title, prompt: 'Name', value: d.name, ignoreFocusOut: true, validateInput: v => (v.trim() ? undefined : 'Name is empty'),
  }))?.trim();
  if (!name) return;
  const addr = await promptAddress(d, title);
  if (!addr) return;
  const dup = duplicateOf(conn, addr.host, addr.port, d.id);
  if (dup) throw new Error(`${addr.host}:${addr.port} is already saved as "${dup.name}".`);
  await conn.saveDevices(conn.devices.map(x => (x.id === d.id ? { ...x, name, ...addr } : x)));
}

/** "Change host" keeps the active device's name and also writes the fallback settings. */
export async function changeHost(conn: Connection): Promise<void> {
  const addr = await promptAddress(conn.address, `Change host of ${conn.label}`);
  if (!addr) return;
  const d = conn.activeDevice;
  if (d) {
    const dup = duplicateOf(conn, addr.host, addr.port, d.id);
    if (dup) throw new Error(`${addr.host}:${addr.port} is already saved as "${dup.name}"; switch to it instead.`);
  }
  const cfg = vscode.workspace.getConfiguration('decky-mcp');
  const target = (key: string) =>
    cfg.inspect(key)?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  await cfg.update('host', addr.host, target('host'));
  await cfg.update('port', addr.port, target('port'));
  if (d) {
    const rename = d.name === d.host ? addr.host : d.name;
    await conn.saveDevices(conn.devices.map(x => (x.id === d.id ? { ...x, name: rename, ...addr } : x)));
  }
}

export async function removeDevice(conn: Connection, arg?: unknown): Promise<void> {
  const d = deviceFrom(conn, arg);
  if (!d) return;
  const ok = await vscode.window.showWarningMessage(
    `Remove ${d.name} (${d.host}:${d.port}) from the saved devices?`,
    { modal: true, detail: 'Its stored token is forgotten too, unless another saved device uses the same address.' },
    'Remove');
  if (!ok) return;
  const rest = conn.devices.filter(x => x.id !== d.id);
  if (!rest.some(x => x.host === d.host && x.port === d.port)) await conn.deleteTokenFor(d);
  await conn.saveDevices(rest);
}

export async function setActiveDevice(conn: Connection, arg?: unknown): Promise<void> {
  const d = arg === undefined ? undefined : deviceFrom(conn, arg);
  if (d) return conn.setActive(d.id);
  return switchDevice(conn);
}

type PickItem = vscode.QuickPickItem & { run?: () => Thenable<unknown> | Promise<unknown> };

export async function switchDevice(conn: Connection): Promise<void> {
  const active = conn.activeDevice;
  const items: PickItem[] = [];
  for (const d of conn.devices) {
    const paired = !!(await conn.tokenFor(d));
    items.push({
      label: `${d.id === active?.id ? '$(check)' : '$(device-mobile)'} ${d.name}`,
      description: `${d.host}:${d.port}`,
      detail: d.id === active?.id ? 'active' : paired ? 'paired' : 'not paired',
      run: () => conn.setActive(d.id),
    });
  }
  items.push(
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    { label: '$(add) Add device…', run: () => addDevice(conn) },
  );
  if (conn.paired) items.push({ label: '$(device-desktop) Open screen', run: () => vscode.commands.executeCommand('decky-mcp.openScreen') });
  const pick = await vscode.window.showQuickPick(items, { placeHolder: `Active: ${conn.label}. Switch Decky device` });
  await pick?.run?.();
}
