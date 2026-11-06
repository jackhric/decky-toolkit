import * as vscode from 'vscode';
import type { NavigateRequest, PluginInfo, UiRoutes } from '@decky-toolkit/client/api';
import { DeckyClient, isOldDevice, serverError } from '@decky-toolkit/client/client';
import type { Connection } from './connection';

export interface NavItem extends vscode.QuickPickItem {
  request?: NavigateRequest;
  /** Path with `{placeholders}` to fill in before navigating. */
  template?: string;
}

const placeholders = (path: string) => [...path.matchAll(/\{([^}]+)\}/g)].map(m => m[1]);

function oldDevice(conn: Connection): void {
  void vscode.window.showWarningMessage(`Decky Toolkit: Steam UI navigation needs a newer Decky Toolkit; update Decky Toolkit on the device (${conn.label}).`);
}

/** QuickPick entries for `GET /ui/routes`: Official, Plugins, then Menus (main menu and Quick Access tabs). */
export function routeItems(routes: UiRoutes): NavItem[] {
  const items: NavItem[] = [];
  const section = (label: string) => items.push({ label, kind: vscode.QuickPickItemKind.Separator });
  const here = (path: string) => (path === routes.current ? ' · current' : '');
  if (routes.official.length) section('Official');
  for (const r of routes.official) {
    const tpl = typeof r.template === 'string' ? r.template : r.path;
    if (r.template || placeholders(tpl).length) items.push({ label: r.title, description: tpl, template: tpl });
    else items.push({ label: r.title, description: r.path + here(r.path), request: { path: r.path } });
  }
  if (routes.plugins.length) section('Plugins');
  for (const p of routes.plugins) items.push({ label: p.title, description: p.path + here(p.path), request: { path: p.path } });
  section('Menus');
  items.push({ label: 'Main menu', request: { action: 'main_menu' } });
  items.push({ label: 'Quick Access', request: { action: 'quick_access' } });
  for (const tab of routes.quick_access_tabs) items.push({ label: `Quick Access › ${tab}`, request: { action: 'quick_access', tab } });
  return items;
}

async function fillTemplate(template: string): Promise<string | undefined> {
  let path = template;
  for (const name of placeholders(template)) {
    const numeric = /id$/i.test(name);
    const value = await vscode.window.showInputBox({
      title: template,
      prompt: name === 'appid' ? 'Steam app ID (the number in the store URL, e.g. 620 for Portal 2)' : `Value for {${name}}`,
      validateInput: v => (!v.trim() ? 'Required' : numeric && !/^\d+$/.test(v.trim()) ? 'Digits only' : undefined),
    });
    if (value === undefined) return undefined;
    path = path.replace(`{${name}}`, encodeURIComponent(value.trim()));
  }
  return path;
}

async function send(conn: Connection, client: DeckyClient, request: NavigateRequest): Promise<void> {
  try {
    const res = await client.navigate(request);
    vscode.window.setStatusBarMessage(`Decky Toolkit: Steam UI at ${res.current}`, 4000);
  } catch (e) {
    if (isOldDevice(e)) return oldDevice(conn);
    throw new Error(`Steam UI navigation: ${serverError(e)}`);
  }
}

export async function navigate(conn: Connection): Promise<void> {
  const client = await conn.client();
  if (!client) return;
  let routes: UiRoutes;
  try {
    routes = await client.uiRoutes();
  } catch (e) {
    if (isOldDevice(e)) return oldDevice(conn);
    throw e;
  }
  const pick = await vscode.window.showQuickPick(routeItems(routes), {
    title: `Navigate ${conn.label}`,
    placeHolder: `Current: ${routes.current}`,
    matchOnDescription: true,
  });
  if (!pick) return;
  const request = pick.request ?? (pick.template ? await fillTemplate(pick.template).then(path => path && { path }) : undefined);
  if (request) await send(conn, client, request);
}

export async function openPluginPanel(conn: Connection, arg?: unknown): Promise<void> {
  const client = await conn.client();
  if (!client) return;
  const fromRow = (arg as { info?: PluginInfo } | undefined)?.info;
  let plugin = typeof arg === 'string' ? arg : fromRow ? fromRow.name ?? fromRow.dir : undefined;
  if (!plugin) {
    const plugins = await client.listPlugins();
    const pick = await vscode.window.showQuickPick(
      plugins.slice().sort((a, b) => (a.name ?? a.dir).localeCompare(b.name ?? b.dir))
        .map(p => ({ label: p.name ?? p.dir, description: p.dir })),
      { placeHolder: 'Open which plugin\'s Quick Access panel?' });
    if (!pick) return;
    plugin = pick.label;
  }
  await send(conn, client, { action: 'plugin', plugin });
}

export async function simpleNavigate(conn: Connection, request: NavigateRequest): Promise<void> {
  const client = await conn.client();
  if (client) await send(conn, client, request);
}
