import * as vscode from 'vscode';

export type Layout = 'devices-first' | 'unified' | 'classic';

export const LAYOUTS: { id: Layout; label: string; detail: string }[] = [
  { id: 'devices-first', label: 'Devices first', detail: 'List of Decks to connect to; Device, Plugins and Preview appear once connected' },
  { id: 'unified', label: 'Unified tree', detail: 'One tree: the connected Deck expands to Screen, Plugins, Actions and Settings' },
  { id: 'classic', label: 'Classic', detail: 'The 0.2 sidebar: active device, connection, Screen and Actions in one view' },
];

export function currentLayout(): Layout {
  const v = vscode.workspace.getConfiguration('decky-mcp').get<string>('sidebarLayout', 'devices-first');
  return LAYOUTS.some(l => l.id === v) ? (v as Layout) : 'devices-first';
}

export async function switchLayout(arg?: unknown): Promise<void> {
  const current = currentLayout();
  let next = LAYOUTS.find(l => l.id === arg)?.id;
  if (!next) {
    const pick = await vscode.window.showQuickPick(
      LAYOUTS.map(l => ({ label: `${l.id === current ? '$(check) ' : ''}${l.label}`, description: l.id, detail: l.detail, id: l.id })),
      { placeHolder: 'Decky sidebar layout (applies immediately)' });
    next = pick?.id;
  }
  if (!next || next === current) return;
  const cfg = vscode.workspace.getConfiguration('decky-mcp');
  const target = cfg.inspect('sidebarLayout')?.workspaceValue !== undefined
    ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  await cfg.update('sidebarLayout', next, target);
}
