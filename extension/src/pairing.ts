import * as vscode from 'vscode';
import type { PairGrant } from './api';
import { DeckyClient, HttpError, describeError, sleep } from './client';
import type { Connection, SavedDevice } from './connection';
import { editDevice } from './devices';

/** Mutable so tests can shorten them. */
export const pairingTimings = { timeoutMs: 120_000, pollMs: 1500 };

let screenOpenedThisSession = false;

async function reachable(d: SavedDevice): Promise<boolean> {
  try {
    await new DeckyClient(d).health();
    return true;
  } catch {
    return false;
  }
}

/** `/health` needs no token, so check one authenticated route; only a 401 means the token is bad. */
async function tokenAccepted(d: SavedDevice, token: string): Promise<boolean> {
  try {
    const res = await new DeckyClient(d, token).fetch('/stream/stats', { timeoutMs: 5000 });
    await res.text();
    return res.status !== 401;
  } catch {
    return true;
  }
}

async function cantReach(c: Connection, d: SavedDevice, retry: () => Promise<unknown>): Promise<void> {
  c.setReachable(d.id, false);
  const choice = await vscode.window.showErrorMessage(
    `Can't reach ${d.name} at ${d.host}:${d.port}. Is the device on and Decky-MCP enabled?`, 'Retry', 'Edit device');
  if (choice === 'Retry') await retry();
  else if (choice === 'Edit device') await editDevice(c, d.id);
}

function fresh(c: Connection, d: SavedDevice): SavedDevice {
  return c.devices.find(x => x.id === d.id) ?? d;
}

function connected(c: Connection, d: SavedDevice, verb?: string): void {
  if (vscode.workspace.getConfiguration('decky-mcp').get<boolean>('openScreenOnConnect', true) && !screenOpenedThisSession) {
    screenOpenedThisSession = true;
    void vscode.commands.executeCommand('decky-mcp.openScreen');
  }
  if (!verb) {
    vscode.window.setStatusBarMessage(`$(vm-connect) Connected to ${d.name}`, 4000);
    return;
  }
  void vscode.window.showInformationMessage(`Decky-MCP: ${verb} ${d.name}.`, 'Open screen', 'Deploy plugin').then(choice => {
    if (choice === 'Open screen') void vscode.commands.executeCommand('decky-mcp.openScreen');
    if (choice === 'Deploy plugin') void vscode.commands.executeCommand('decky-mcp.deploy');
  });
}

/**
 * Connects with the stored token, or goes straight into pairing when there is none or the device
 * rejects it. Non-interactive calls (silent reconnect at startup) never prompt.
 */
export async function connect(c: Connection, device: SavedDevice, interactive = true): Promise<boolean> {
  let d = fresh(c, device);
  const status = c.statusOf(d);
  if (status === 'connecting' || status === 'pairing') return false;
  if (c.connectedDevice?.id === d.id && status === 'connected') return true;
  c.setBusy(d.id, 'connecting');
  let outcome: 'connected' | 'unreachable' | 'pair';
  try {
    if (c.activeDevice?.id !== d.id) await c.setActive(d.id);
    d = fresh(c, d);
    if (!(await reachable(d))) {
      outcome = 'unreachable';
    } else {
      const token = await c.tokenFor(d);
      outcome = token && (await tokenAccepted(d, token)) ? 'connected' : 'pair';
      if (outcome === 'connected') await c.markConnected(d.id);
    }
  } finally {
    c.setBusy(d.id, undefined);
  }
  if (outcome === 'unreachable') {
    if (interactive) await cantReach(c, d, () => connect(c, d));
    else c.setReachable(d.id, false);
    return false;
  }
  c.setReachable(d.id, true);
  if (outcome === 'connected') {
    if (interactive) connected(c, d);
    return true;
  }
  return interactive ? pair(c, d, true) : false;
}

export async function pair(c: Connection, device: SavedDevice, reachabilityChecked = false): Promise<boolean> {
  if (c.activeDevice?.id !== device.id) await c.setActive(device.id);
  const d = fresh(c, device);
  if (!reachabilityChecked && !(await reachable(d))) {
    await cantReach(c, d, () => pair(c, d));
    return false;
  }
  c.setReachable(d.id, true);
  c.setBusy(d.id, 'pairing');
  let grant: PairGrant | 'cancelled' | 'timeout' | 'unsupported';
  try {
    grant = await pollForGrant(d);
  } finally {
    c.setBusy(d.id, undefined);
  }
  if (grant === 'cancelled') return false;
  if (grant === 'unsupported') {
    const choice = await vscode.window.showWarningMessage(
      `Decky-MCP: ${d.name} runs an older Decky-MCP without pairing. Copy the token from its Decky-MCP panel instead.`,
      'Enter token manually');
    return choice ? enterToken(c, d) : false;
  }
  if (grant === 'timeout') {
    const choice = await vscode.window.showWarningMessage(
      `Decky-MCP: Pairing timed out. Nobody pressed "Pair a browser" on ${d.name} within ${Math.ceil(pairingTimings.timeoutMs / 1000)} s.`,
      'Try again', 'Enter token manually');
    if (choice === 'Try again') return pair(c, d);
    if (choice === 'Enter token manually') return enterToken(c, d);
    return false;
  }
  await c.setTokenFor(d, grant.token);
  await c.markConnected(d.id);
  connected(c, d, 'Paired with');
  return true;
}

function pollForGrant(d: SavedDevice): Thenable<PairGrant | 'cancelled' | 'timeout' | 'unsupported'> {
  const client = new DeckyClient(d);
  const { timeoutMs, pollMs } = pairingTimings;
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Pairing with ${d.name}`, cancellable: true },
    async (progress, token) => {
      const start = Date.now();
      const abort = new AbortController();
      const cancelSub = token.onCancellationRequested(() => abort.abort());
      const report = () => {
        const left = Math.max(0, Math.ceil((timeoutMs - (Date.now() - start)) / 1000));
        progress.report({ message: `on the device, open Quick Access → Decky-MCP → Pair a browser. Waiting… ${left} s` });
      };
      report();
      const ticker = setInterval(report, 1000);
      try {
        while (!abort.signal.aborted && Date.now() - start < timeoutMs) {
          try {
            const r = await client.pair();
            if (r !== 'closed') return r;
          } catch {
            // transient (loader restarting); keep polling
          }
          await sleep(Math.min(pollMs, Math.max(0, timeoutMs - (Date.now() - start))), abort.signal).catch(() => undefined);
        }
        return abort.signal.aborted ? 'cancelled' as const : 'timeout' as const;
      } finally {
        clearInterval(ticker);
        cancelSub.dispose();
      }
    });
}

export async function enterToken(c: Connection, device?: SavedDevice): Promise<boolean> {
  const d = device ? fresh(c, device) : c.activeDevice;
  const label = d?.name ?? c.label;
  const token = (await vscode.window.showInputBox({
    prompt: `Bearer token for ${label} (shown in the Decky-MCP Quick Access panel)`,
    password: true,
    ignoreFocusOut: true,
    validateInput: v => (v.trim() ? undefined : 'Token is empty'),
  }))?.trim();
  if (!token) return false;
  try {
    await new DeckyClient(d ?? c.address, token).listTools();
  } catch (e) {
    if (e instanceof HttpError && e.status === 401) throw new Error('the device rejected that token.');
    void vscode.window.showWarningMessage(`Decky-MCP: could not verify the token (${describeError(e)}); saved it anyway.`);
  }
  if (!d) {
    await c.setToken(token);
    return true;
  }
  if (c.activeDevice?.id !== d.id) await c.setActive(d.id);
  await c.setTokenFor(d, token);
  await c.markConnected(d.id);
  connected(c, d, 'Connected to');
  return true;
}
