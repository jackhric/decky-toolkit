import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as path from 'path';
import { DeckyClient, describeError, isMissingRoute } from './client';
import { stagePlugin } from './stage';

export interface PluginFolder {
  folder: vscode.WorkspaceFolder;
  name: string;
}

export async function findPluginFolders(): Promise<PluginFolder[]> {
  const found: PluginFolder[] = [];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    try {
      const raw = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, 'plugin.json'));
      const meta = JSON.parse(Buffer.from(raw).toString('utf8')) as { name?: string };
      found.push({ folder, name: meta.name ?? folder.name });
    } catch {
      // not a plugin folder
    }
  }
  return found;
}

export async function pickPluginFolder(): Promise<PluginFolder | undefined> {
  const folders = await findPluginFolders();
  if (folders.length === 0) {
    void vscode.window.showErrorMessage('Decky-MCP: no workspace folder contains a plugin.json.');
    return undefined;
  }
  if (folders.length === 1) return folders[0];
  const pick = await vscode.window.showQuickPick(
    folders.map(f => ({ label: f.name, description: f.folder.uri.fsPath, f })),
    { placeHolder: 'Which plugin?' });
  return pick?.f;
}

export function pluginDirName(p: PluginFolder): string {
  const override = vscode.workspace.getConfiguration('decky-mcp').get<string>('pluginDirName', '').trim();
  return override || path.basename(p.folder.uri.fsPath);
}

function runBuild(cwd: string, out: vscode.OutputChannel, token: vscode.CancellationToken): Promise<void> {
  return new Promise((resolve, reject) => {
    out.appendLine(`$ pnpm run build   (in ${cwd})`);
    // shell: true so pnpm.cmd resolves on Windows and the user's PATH (nvm, corepack) applies.
    const child = spawn('pnpm run build', { cwd, shell: true, env: process.env });
    child.stdout.on('data', d => out.append(d.toString()));
    child.stderr.on('data', d => out.append(d.toString()));
    const sub = token.onCancellationRequested(() => child.kill());
    child.on('error', e => { sub.dispose(); reject(e); });
    child.on('close', code => {
      sub.dispose();
      if (token.isCancellationRequested) reject(new vscode.CancellationError());
      else if (code === 0) resolve();
      else reject(new Error(`pnpm run build exited with code ${code}; see the "Decky-MCP Deploy" output`));
    });
  });
}

export async function deploy(client: DeckyClient, out: vscode.OutputChannel): Promise<void> {
  const plugin = await pickPluginFolder();
  if (!plugin) return;
  const dir = pluginDirName(plugin);
  const root = plugin.folder.uri.fsPath;
  out.show(true);
  out.appendLine(`\n=== Deploying ${plugin.name} → ~/homebrew/plugins/${dir} on ${client.address.host} (${new Date().toLocaleTimeString()})`);

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Deploying ${plugin.name}`, cancellable: true },
    async (progress, token) => {
      try {
        progress.report({ message: 'building…' });
        await runBuild(root, out, token);

        progress.report({ message: 'packaging…' });
        const { zip, files } = await stagePlugin(root, dir);
        out.appendLine(`Staged ${files.join(', ')} → ${(zip.length / 1024).toFixed(0)} KiB zip`);

        progress.report({ message: 'uploading…' });
        let result;
        try {
          result = await client.installPlugin(zip, `${dir}.zip`, 'loader');
        } catch (e) {
          if (isMissingRoute(e)) {
            throw new Error('the Decky-MCP plugin on the device has no POST /plugins/install yet. ' +
              'Update it to a version with install support (deploy it once with scripts/deploy.sh).');
          }
          throw e;
        }
        out.appendLine(`Installed ${result.installed.name} ${result.installed.version ?? ''} in ${result.installed.dir}; restart: ${result.restarted}`);

        if (result.restarted === 'loader') {
          progress.report({ message: 'waiting for the loader to restart…' });
          const health = await client.waitForRestart();
          out.appendLine(`Device back: ${health.name} ${health.version}`);
        }
        void vscode.window.showInformationMessage(`Decky-MCP: deployed ${result.installed.name} to ${client.address.host}.`);
      } catch (e) {
        if (e instanceof vscode.CancellationError) {
          out.appendLine('Cancelled.');
          return;
        }
        out.appendLine(`Deploy failed: ${describeError(e)}`);
        void vscode.window.showErrorMessage(`Decky-MCP deploy failed: ${describeError(e)}`);
      }
    });
}
