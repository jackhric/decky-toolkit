import * as vscode from 'vscode';
import { Connection, DeviceStatus, SavedDevice, newDeviceId } from './connection';

const DEFAULT_PORT = 8765;
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

function splitHostPort(v: string): { host: string; port?: number } {
  const m = /^([^:]+):(\d+)$/.exec(v.trim());
  return m ? { host: m[1], port: Number(m[2]) } : { host: v.trim() };
}

function validateHostPort(v: string): string | undefined {
  const { host, port } = splitHostPort(v);
  return validateHost(host) ?? (port === undefined ? undefined : validatePort(String(port)));
}

async function promptAddress(initial: { host: string; port: number }, title: string): Promise<{ host: string; port: number } | undefined> {
  const host = (await vscode.window.showInputBox({
    title, prompt: 'IP address or hostname of the device (any machine running Decky Loader)', value: initial.host, ignoreFocusOut: true, validateInput: validateHost,
  }))?.trim();
  if (!host) return undefined;
  const port = (await vscode.window.showInputBox({
    title, prompt: 'Decky Toolkit port', value: String(initial.port), ignoreFocusOut: true, validateInput: validatePort,
  }))?.trim();
  if (!port) return undefined;
  return { host, port: Number(port) };
}

/** Accepts a tree node, a device id or nothing (then the active device). */
export function deviceFrom(conn: Connection, arg: unknown): SavedDevice | undefined {
  const id = typeof arg === 'string' ? arg : (arg as { device?: SavedDevice } | undefined)?.device?.id;
  return id ? conn.devices.find(d => d.id === id) : conn.activeDevice;
}

function duplicateOf(conn: Connection, host: string, port: number, exceptId?: string): SavedDevice | undefined {
  return conn.devices.find(d => d.id !== exceptId && d.host === host && d.port === port);
}

/** Asks for the host (`host:port` also works) and an optional name; the port only on request. */
export async function addDevice(conn: Connection): Promise<void> {
  const title = 'Add Decky device';
  const raw = (await vscode.window.showInputBox({
    title, prompt: 'IP address or hostname of the device (any machine running Decky Loader)', placeHolder: 'e.g. 192.168.1.40 or steamdeck.local',
    ignoreFocusOut: true, validateInput: validateHostPort,
  }))?.trim();
  if (!raw) return;
  const { host, port: typedPort } = splitHostPort(raw);
  let port = typedPort ?? DEFAULT_PORT;
  const dup = duplicateOf(conn, host, port);
  if (dup) throw new Error(`${host}:${port} is already saved as "${dup.name}".`);
  const name = await vscode.window.showInputBox({
    title, prompt: 'Name (optional; press Enter to use the host)', placeHolder: host, ignoreFocusOut: true,
  });
  if (name === undefined) return;
  const device: SavedDevice = { id: newDeviceId(), name: name.trim() || host, host, port };
  await conn.saveDevices([...conn.devices, device]);
  for (;;) {
    const items = [
      { label: `$(plug) Connect to ${device.name}`, id: 'connect' },
      { label: `$(settings-gear) Change port (${port})…`, id: 'port' },
      { label: '$(close) Not now', id: 'later' },
    ];
    const pick = await vscode.window.showQuickPick(items, { title: `Added ${device.name}`, placeHolder: `${host}:${port}`, ignoreFocusOut: true });
    if (pick?.id === 'connect') {
      await vscode.commands.executeCommand('decky-toolkit.connect', device.id);
      return;
    }
    if (pick?.id !== 'port') return;
    const p = (await vscode.window.showInputBox({
      title, prompt: 'Decky Toolkit port', value: String(port), ignoreFocusOut: true, validateInput: validatePort,
    }))?.trim();
    if (!p) continue;
    const other = duplicateOf(conn, host, Number(p), device.id);
    if (other) throw new Error(`${host}:${p} is already saved as "${other.name}".`);
    port = Number(p);
    await conn.saveDevices(conn.devices.map(x => (x.id === device.id ? { ...x, port } : x)));
  }
}

export async function renameDevice(conn: Connection, arg?: unknown): Promise<void> {
  const d = deviceFrom(conn, arg);
  if (!d) return;
  const name = (await vscode.window.showInputBox({
    title: `Rename ${d.name}`, prompt: 'Name shown in the Devices view', value: d.name, ignoreFocusOut: true,
    validateInput: v => (v.trim() ? undefined : 'Name is empty'),
  }))?.trim();
  if (!name || name === d.name) return;
  await conn.saveDevices(conn.devices.map(x => (x.id === d.id ? { ...x, name } : x)));
}

export async function removeDevice(conn: Connection, arg?: unknown): Promise<void> {
  const d = deviceFrom(conn, arg);
  if (!d) return;
  const ok = await vscode.window.showWarningMessage(
    `Forget ${d.name} (${d.host}:${d.port})?`,
    { modal: true, detail: 'Its pairing is deleted. Connecting to it again asks for approval on the device.' },
    'Forget');
  if (!ok) return;
  const rest = conn.devices.filter(x => x.id !== d.id);
  if (!rest.some(x => x.host === d.host && x.port === d.port)) await conn.deleteIdentityFor(d);
  await conn.saveDevices(rest);
}

type PickItem = vscode.QuickPickItem & { run?: () => Thenable<unknown> | Promise<unknown> };

export const STATUS_ICON: Record<DeviceStatus, string> = {
  unpaired: 'key',
  disconnected: 'vm',
  connecting: 'loading~spin',
  pairing: 'sync~spin',
  connected: 'vm-connect',
  unreachable: 'warning',
};

export function statusLabel(status: DeviceStatus): string {
  switch (status) {
    case 'unpaired': return 'not paired';
    case 'disconnected': return 'paired';
    case 'connecting': return 'connecting…';
    case 'pairing': return 'pairing…';
    default: return status;
  }
}

/** The status bar / "Switch device" picker: connect to (or switch to) a saved device. */
export async function switchDevice(conn: Connection): Promise<void> {
  const connected = conn.connectedDevice;
  const items: PickItem[] = [];
  for (const d of conn.devices) {
    const status = conn.statusOf(d);
    const isConnected = d.id === connected?.id;
    items.push({
      label: `$(${STATUS_ICON[status]}) ${d.name}`,
      description: `${d.host}:${d.port}`,
      detail: isConnected ? statusLabel(status) : `${statusLabel(status)} · select to ${connected ? 'switch to it' : 'connect'}`,
      run: isConnected ? undefined : () => vscode.commands.executeCommand('decky-toolkit.connect', d.id),
    });
  }
  items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
  if (connected) {
    items.push(
      { label: `$(debug-disconnect) Disconnect from ${connected.name}`, run: () => vscode.commands.executeCommand('decky-toolkit.disconnectDevice') },
      { label: '$(device-desktop) Open screen', run: () => vscode.commands.executeCommand('decky-toolkit.openScreen') },
    );
  }
  items.push({ label: '$(add) Add device…', run: () => addDevice(conn) });
  const pick = await vscode.window.showQuickPick(items, { placeHolder: connected ? `Connected to ${connected.name}` : 'Connect to a device' });
  await pick?.run?.();
}

/** The `…` overflow of a device row: everything except the row's primary action. */
export async function deviceActions(conn: Connection, arg?: unknown): Promise<void> {
  const d = deviceFrom(conn, arg);
  if (!d) return;
  const status = conn.statusOf(d);
  const run = (cmd: string) => () => vscode.commands.executeCommand(cmd, d.id);
  const items: PickItem[] = [
    { label: '$(pencil) Rename…', run: run('decky-toolkit.renameDevice') },
    { label: '$(trash) Forget device', run: run('decky-toolkit.removeDevice') },
  ];
  const pick = await vscode.window.showQuickPick(items, { placeHolder: `${d.name} · ${statusLabel(status)}` });
  await pick?.run?.();
}
