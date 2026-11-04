import * as vscode from 'vscode';
import type { Connection, InputState } from './connection';

export const INPUT_UNSUPPORTED = 'not supported by this device version';

export function inputBackendLabel(backend: string | null): string {
  return backend === 'ei' ? 'libei' : backend ?? '';
}

export function inputOn(input: InputState | undefined): boolean {
  return typeof input === 'object' && input.enabled;
}

/** Shared by the Actions leaf, the command palette and the screen panel's Input button. */
export async function toggleInput(c: Connection, enabled?: boolean): Promise<void> {
  const client = await c.client();
  if (!client) return;
  const current = await c.refreshInput() ?? c.input;
  if (current === 'unsupported') {
    void vscode.window.showWarningMessage(`Decky-MCP: remote input is ${INPUT_UNSUPPORTED}; update the Decky-MCP plugin on ${c.label}.`);
    return;
  }
  if (current && !current.available && !current.enabled) {
    void vscode.window.showWarningMessage(`Decky-MCP: remote input is unavailable on ${c.label}${current.reason ? `: ${current.reason}` : '.'}`);
    return;
  }
  const next = await c.setInputEnabled(enabled ?? !current?.enabled);
  vscode.window.setStatusBarMessage(
    `Decky-MCP: remote input ${next.enabled ? `on (${inputBackendLabel(next.backend)})` : 'off'} for ${c.label}`, 4000);
}
