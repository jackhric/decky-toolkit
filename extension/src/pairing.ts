import * as vscode from 'vscode';
import { hostname } from 'os';
import type { PairGrant } from './api';
import { DeckyClient, HttpError, describeError, sleep } from './client';
import type { Connection, SavedDevice } from './connection';
import { editDevice } from './devices';

/** Mutable so tests can shorten them. There is no overall timeout: pairing waits until approved, denied or cancelled. */
export const pairingTimings = { waitS: 25, retryMs: 2000 };

type PairOutcome = PairGrant | 'cancelled' | 'denied' | 'unsupported' | { error: string };

function clientName(): string {
  const app = vscode.env.appName ?? '';
  const ide = /cursor/i.test(app) ? 'Cursor' : /vscodium/i.test(app) ? 'VSCodium' : 'VS Code';
  return `${ide} on ${hostname()}`.slice(0, 64);
}

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
  let outcome: PairOutcome;
  try {
    outcome = await waitForApproval(c, d);
  } finally {
    c.setPairingCode(d.id, undefined);
    c.setBusy(d.id, undefined);
  }
  if (outcome === 'cancelled') return false;
  if (outcome === 'unsupported') {
    const choice = await vscode.window.showWarningMessage(
      `Decky-MCP: Update Decky-MCP on ${d.name} to pair. Until then, copy the token from its Decky-MCP panel.`,
      'Enter token manually');
    return choice ? enterToken(c, d) : false;
  }
  if (outcome === 'denied') {
    const choice = await vscode.window.showWarningMessage(`Decky-MCP: Pairing denied on ${d.name}.`, 'Try again');
    return choice === 'Try again' ? pair(c, d) : false;
  }
  if ('error' in outcome) {
    const choice = await vscode.window.showWarningMessage(
      `Decky-MCP: Pairing with ${d.name} failed: ${outcome.error}`, 'Try again', 'Enter token manually');
    if (choice === 'Try again') return pair(c, d);
    if (choice === 'Enter token manually') return enterToken(c, d);
    return false;
  }
  await c.setTokenFor(d, outcome.token);
  await c.markConnected(d.id);
  connected(c, d, 'Paired with');
  return true;
}

/** Files a pairing request and long-polls it; a request the device forgot is filed again (new code). */
function waitForApproval(c: Connection, d: SavedDevice): Thenable<PairOutcome> {
  const client = new DeckyClient(d);
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Decky-MCP', cancellable: true },
    async (progress, token) => {
      const abort = new AbortController();
      const cancelSub = token.onCancellationRequested(() => abort.abort());
      const pause = () => sleep(pairingTimings.retryMs, abort.signal).catch(() => undefined);
      let id: string | undefined;
      let code: string | undefined;
      const waiting = () => `Waiting for approval on ${d.name} · code ${code}. On the device: Quick Access → Decky-MCP → Approve.`;
      const lostContact = (e: unknown) =>
        progress.report({ message: `Lost contact with ${d.name} (${describeError(e)}), retrying…${code ? ` Code ${code}.` : ''}` });
      try {
        while (!abort.signal.aborted) {
          if (!id) {
            let created;
            try {
              created = await client.requestPairing(clientName());
            } catch (e) {
              if (e instanceof HttpError) return { error: describeError(e) };
              lostContact(e);
              await pause();
              continue;
            }
            if (created === 'unsupported') return 'unsupported';
            ({ id, code } = created);
            c.setPairingCode(d.id, code);
            progress.report({ message: waiting() });
          }
          let r;
          try {
            r = await client.pollPairing(id, pairingTimings.waitS, abort.signal);
          } catch (e) {
            if (abort.signal.aborted) break;
            lostContact(e);
            await pause();
            continue;
          }
          if (r === 'gone') {
            id = undefined;
            continue;
          }
          progress.report({ message: waiting() });
          if (r.status === 'denied') return 'denied';
          if (r.status === 'approved') {
            if (r.token && r.url) return { token: r.token, url: r.url, api_version: r.api_version ?? 1 };
            return { error: 'the device approved the request but the token was already handed out' };
          }
        }
        return 'cancelled';
      } finally {
        cancelSub.dispose();
        if (abort.signal.aborted && id) void client.cancelPairing(id).catch(() => undefined);
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
