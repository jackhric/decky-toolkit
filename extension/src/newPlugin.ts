import { homedir } from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { describeError } from '@decky-toolkit/client/client';
import {
  BUILD_INFO, BUILD_TOOLS, BuildTool, CommandError, CreatePhase, PINNED_TEMPLATE, TemplateVersion, VARIANT_INFO, VARIANTS, Variant,
  createPlugin, defaultAuthor, nameProblem, slugify, targetProblem,
} from '@decky-toolkit/client/scaffold';
import type { Connection } from './connection';
import type { DeployController, PluginWorkspace } from './deploy';

/** Set before the new plugin's folder opens (which may restart this window); the window that opens it deploys. */
export const PENDING_KEY = 'decky-toolkit.newPlugin.pending';
const PENDING_TTL_MS = 10 * 60 * 1000;
const CONNECT_WAIT_MS = 30000;

interface Pending {
  root: string;
  at: number;
}

const PHASE_TEXT: Record<CreatePhase, string> = {
  downloading: 'downloading the template…', writing: 'writing files…', installing: 'installing dependencies with pnpm…', building: 'building…',
};

const STEPS = 6;
const title = (step: number) => `New Decky Plugin (${step}/${STEPS})`;

async function pick<T>(step: number, placeHolder: string, items: (vscode.QuickPickItem & { value: T })[]): Promise<T | undefined> {
  return (await vscode.window.showQuickPick(items, { title: title(step), placeHolder, ignoreFocusOut: true }))?.value;
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  return norm(a) === norm(b);
}

/** Asks for everything, creates and builds the plugin, then opens it; the deploy happens in the window that opens it. */
export async function newPlugin(ctx: vscode.ExtensionContext, conn: Connection, out: vscode.OutputChannel): Promise<void> {
  const device = conn.paired ? conn.connectedDevice ?? conn.activeDevice : undefined;
  const client = conn.connectedDevice && conn.authedClient();
  const installed = new Set<string>();
  void client?.listPlugins().then(ps => ps.forEach(p => p.name && installed.add(p.name)), () => undefined);

  const name = (await vscode.window.showInputBox({
    title: title(1), prompt: 'Plugin name, as Decky shows it', placeHolder: 'My Plugin', ignoreFocusOut: true,
    validateInput: v => nameProblem(v) ?? (installed.has(v.trim())
      ? { message: `${device?.name ?? 'The device'} already has a plugin named ${v.trim()}; deploying this one would replace it`, severity: vscode.InputBoxValidationSeverity.Warning }
      : undefined),
  }))?.trim();
  if (!name) return;
  const author = (await vscode.window.showInputBox({ title: title(2), prompt: 'Author', value: defaultAuthor(), ignoreFocusOut: true }))?.trim();
  if (!author) return;
  const variant = await pick<Variant>(3, 'What should the plugin have?', VARIANTS.map(v => ({ label: VARIANT_INFO[v].label, detail: VARIANT_INFO[v].detail, value: v })));
  if (!variant) return;
  const build = await pick<BuildTool>(4, 'Build tool', BUILD_TOOLS.map(b => ({ label: BUILD_INFO[b].label, detail: BUILD_INFO[b].detail, value: b })));
  if (!build) return;
  const template = await pick<TemplateVersion>(5, 'Which version of decky-plugin-template?', [
    { label: 'Pinned (tested)', description: PINNED_TEMPLATE.slice(0, 7), detail: 'The commit this version of Decky Toolkit was tested with', value: 'pinned' },
    { label: 'Latest upstream', detail: 'The template\'s main branch as it is now', value: 'latest' },
  ]);
  if (!template) return;
  const folder = vscode.workspace.workspaceFolders?.find(f => !f.uri.scheme || f.uri.scheme === 'file')?.uri.fsPath;
  const [parent] = await vscode.window.showOpenDialog({
    title: `${title(6)}: where to create the ${slugify(name)} folder`, canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
    openLabel: 'Create here', defaultUri: vscode.Uri.file(folder ? path.dirname(folder) : homedir()),
  }) ?? [];
  if (!parent) return;
  const root = path.join(parent.fsPath, slugify(name));
  const problem = await targetProblem(root);
  if (problem) throw new Error(`cannot create the plugin: ${problem}.`);

  out.appendLine(`\n=== New plugin ${name} in ${root} (${variant}, ${build}, template ${template}, ${new Date().toLocaleTimeString()})`);
  out.show(true);
  const ac = new AbortController();
  let created;
  try {
    created = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Creating ${name}`, cancellable: true }, (progress, token) => {
      token.onCancellationRequested(() => ac.abort(new vscode.CancellationError()));
      return createPlugin({
        name, author, variant, build, template, dir: root, signal: ac.signal, log: l => out.appendLine(l),
        onPhase: p => progress.report({ message: PHASE_TEXT[p] }),
      });
    });
  } catch (e) {
    if (ac.signal.aborted) {
      out.appendLine('Cancelled.');
      return;
    }
    const why = e instanceof CommandError ? e.message : describeError(e);
    out.appendLine(`Creating the plugin failed: ${why}`);
    void vscode.window.showErrorMessage(`Decky Toolkit: creating ${name} failed: ${why}`, 'Show output').then(c => { if (c) out.show(true); });
    return;
  }
  const commit = created.commit ? ` ${created.commit.slice(0, 7)}` : '';
  out.appendLine(`Created ${name} in ${(created.ms.total / 1000).toFixed(1)} s from decky-plugin-template${commit}`);

  const reuse = !vscode.workspace.workspaceFolders?.length;
  const where = reuse ? 'in this window' : 'in a new window';
  const actions = device ? ['Open and Deploy', 'Open'] : ['Open'];
  const detail = device
    ? `Template ${template}${commit}. Open and Deploy opens the folder ${where}, installs it on ${device.name} (the first install restarts Decky Loader) and turns on auto-deploy, so every change is pushed and reloaded in place.`
    : `Template ${template}${commit}. The folder opens ${where}. Pair a device to deploy it.`;
  const choice = await vscode.window.showInformationMessage(`Created ${name} in ${root}.`, { modal: true, detail }, ...actions);
  if (!choice) return;
  if (choice === 'Open and Deploy') await ctx.globalState.update(PENDING_KEY, { root, at: Date.now() } satisfies Pending);
  await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(root), { forceNewWindow: !reuse });
}

function whenConnected(conn: Connection, ms: number): Promise<boolean> {
  if (conn.connectedDevice) return Promise.resolve(true);
  return new Promise(resolve => {
    const timer = setTimeout(() => { sub.dispose(); resolve(false); }, ms);
    const sub = conn.onDidChange(() => {
      if (!conn.connectedDevice) return;
      clearTimeout(timer);
      sub.dispose();
      resolve(true);
    });
  });
}

/** In the window that opened a plugin `newPlugin` created with Open and Deploy: deploy it and start live sync. */
export async function resumeNewPlugin(ctx: vscode.ExtensionContext, conn: Connection, ws: PluginWorkspace, deployer: DeployController): Promise<void> {
  const pending = ctx.globalState.get<Pending>(PENDING_KEY);
  if (!pending) return;
  if (Date.now() - pending.at > PENDING_TTL_MS) {
    await ctx.globalState.update(PENDING_KEY, undefined);
    return;
  }
  // Another window starting meanwhile leaves the flag for the one that has the folder.
  if (!vscode.workspace.workspaceFolders?.some(f => (!f.uri.scheme || f.uri.scheme === 'file') && samePath(pending.root, f.uri.fsPath))) return;
  deployer.skipDetectPrompt();
  await ctx.globalState.update(PENDING_KEY, undefined);
  // A fresh scan: after a folder change the debounced one has not started yet.
  const p = (await ws.refresh()).find(x => samePath(x.root, pending.root));
  if (!p) return;
  await whenConnected(conn, CONNECT_WAIT_MS);
  await deployer.deployAndSync(p);
}
