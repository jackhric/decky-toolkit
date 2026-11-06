import * as vscode from 'vscode';
import { hostname } from 'os';
import { DeckyClient, describeError, isRejection } from '@decky-toolkit/client/client';
import { PairOutcome, requestApproval } from '@decky-toolkit/client/pairing';
import { Identity, isPlainHttpDevice } from '@decky-toolkit/client/transport';
import type { Connection, SavedDevice } from './connection';

export { pairingCode, pairingTimings } from '@decky-toolkit/client/pairing';

function clientName(): string {
  const app = vscode.env.appName ?? '';
  const ide = /cursor/i.test(app) ? 'Cursor' : /vscodium/i.test(app) ? 'VSCodium' : 'VS Code';
  return `${ide} on ${hostname()}`.slice(0, 64);
}

let screenOpenedThisSession = false;

async function reachable(c: Connection, d: SavedDevice): Promise<boolean> {
  try {
    c.noteVersion(d.id, (await new DeckyClient(d).health()).version);
    return true;
  } catch (e) {
    // An older plugin still answers; pairing then says it needs an update.
    return isPlainHttpDevice(e);
  }
}

/** `/health` needs no pairing, so check one paired route; only a rejection means the pairing is gone. */
async function identityAccepted(d: SavedDevice, identity: Identity): Promise<boolean> {
  try {
    const res = await new DeckyClient(d, identity).fetch('/stream/stats', { timeoutMs: 5000 });
    await res.text();
    return res.status !== 401;
  } catch (e) {
    return !(isRejection(e) || isPlainHttpDevice(e));
  }
}

async function cantReach(c: Connection, d: SavedDevice, retry: () => Promise<unknown>): Promise<void> {
  c.setReachable(d.id, false);
  const choice = await vscode.window.showErrorMessage(
    `Can't reach ${d.name} at ${d.host}:${d.port}. Is the device on and Decky Toolkit enabled?`, 'Retry');
  if (choice === 'Retry') await retry();
}

function fresh(c: Connection, d: SavedDevice): SavedDevice {
  return c.devices.find(x => x.id === d.id) ?? d;
}

function connected(c: Connection, d: SavedDevice, verb?: string): void {
  if (vscode.workspace.getConfiguration('decky-toolkit').get<boolean>('openScreenOnConnect', true) && !screenOpenedThisSession) {
    screenOpenedThisSession = true;
    void vscode.commands.executeCommand('decky-toolkit.openScreen');
  }
  if (!verb) {
    vscode.window.setStatusBarMessage(`$(vm-connect) Connected to ${d.name}`, 4000);
    return;
  }
  void vscode.window.showInformationMessage(`Decky Toolkit: ${verb} ${d.name}.`, 'Open screen', 'Deploy plugin').then(choice => {
    if (choice === 'Open screen') void vscode.commands.executeCommand('decky-toolkit.openScreen');
    if (choice === 'Deploy plugin') void vscode.commands.executeCommand('decky-toolkit.deploy');
  });
}

/**
 * Connects with the stored pairing, or goes straight into pairing when there is none or the device
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
    if (!(await reachable(c, d))) {
      outcome = 'unreachable';
    } else {
      const identity = await c.identityFor(d);
      outcome = identity && (await identityAccepted(d, identity)) ? 'connected' : 'pair';
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
  if (!reachabilityChecked && !(await reachable(c, d))) {
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
    void vscode.window.showWarningMessage(`Decky Toolkit: Update Decky Toolkit on ${d.name} to pair with it.`);
    return false;
  }
  if (outcome === 'mismatch') {
    const choice = await vscode.window.showWarningMessage(`Decky Toolkit: could not pair with ${d.name}. Try again.`, 'Try again');
    return choice === 'Try again' ? pair(c, d) : false;
  }
  if (outcome === 'denied') {
    const choice = await vscode.window.showWarningMessage(`Decky Toolkit: Pairing denied on ${d.name}.`, 'Try again');
    return choice === 'Try again' ? pair(c, d) : false;
  }
  if ('error' in outcome) {
    const choice = await vscode.window.showWarningMessage(
      `Decky Toolkit: Pairing with ${d.name} failed: ${outcome.error}`, 'Try again');
    return choice === 'Try again' ? pair(c, d) : false;
  }
  await c.setIdentityFor(d, outcome.identity);
  await c.markConnected(d.id);
  connected(c, d, 'Paired with');
  return true;
}

/** The pairing flow behind a cancellable progress notification. */
function waitForApproval(c: Connection, d: SavedDevice): Thenable<PairOutcome> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Decky Toolkit', cancellable: true },
    async (progress, token) => {
      const abort = new AbortController();
      const cancelSub = token.onCancellationRequested(() => abort.abort());
      const waiting = (code: string) => progress.report({
        message: `Waiting for approval on ${d.name} · code ${code}. On the device: Quick Access → Decky Toolkit → Approve.`,
      });
      try {
        return await requestApproval(new DeckyClient(d), {
          clientName: clientName(),
          signal: abort.signal,
          onCode: code => {
            c.setPairingCode(d.id, code);
            waiting(code);
          },
          onPoll: waiting,
          onLostContact: (e, code) =>
            progress.report({ message: `Lost contact with ${d.name} (${describeError(e)}), retrying…${code ? ` Code ${code}.` : ''}` }),
        });
      } finally {
        cancelSub.dispose();
      }
    });
}
