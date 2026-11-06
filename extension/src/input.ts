import * as vscode from 'vscode';
import type { InputSettings } from '@decky-toolkit/client/api';
import type { Connection } from './connection';

export function inputBackendLabel(backend: string | null): string {
  return backend === 'ei' ? 'libei' : backend ?? '';
}

export function inputOn(input: InputSettings | undefined): boolean {
  return !!input?.enabled;
}

/** Shared by the Actions leaf, the command palette and the screen panel's Input button. */
export async function toggleInput(c: Connection, enabled?: boolean): Promise<void> {
  const client = await c.client();
  if (!client) return;
  const current = await c.refreshInput() ?? c.input;
  if (current && !current.available && !current.enabled) {
    void vscode.window.showWarningMessage(`Decky Toolkit: remote input is unavailable on ${c.label}${current.reason ? `: ${current.reason}` : '.'}`);
    return;
  }
  const next = await c.setInputEnabled(enabled ?? !current?.enabled);
  vscode.window.setStatusBarMessage(
    `Decky Toolkit: remote input ${next.enabled ? `on (${inputBackendLabel(next.backend)})` : 'off'} for ${c.label}`, 4000);
}
