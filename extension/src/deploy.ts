import type { ChildProcess } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { describeError, outdatedDevice } from '@decky-toolkit/client/client';
import {
  BuildError, BuildMode, DeployPhase, DeployStep, WorkspacePlugin, deployPlugin, findPluginRoots, readWorkspacePlugin,
} from '@decky-toolkit/client/deploy';
import { LiveSync, startWatchBuild, stopWatchBuild } from '@decky-toolkit/client/live';
import type { Connection } from './connection';

const SCAN_DEBOUNCE_MS = 150;
export const AUTO_DEPLOY_DEBOUNCE_MS = 750;

function samePlugins(a: WorkspacePlugin[], b: WorkspacePlugin[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Decky plugins (folders with a plugin.json, at most two levels deep) in the open workspace. */
export class PluginWorkspace implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private list: WorkspacePlugin[] = [];
  private scan: Promise<WorkspacePlugin[]>;
  private timer?: NodeJS.Timeout;
  private readonly subs: vscode.Disposable[];

  constructor() {
    const watcher = vscode.workspace.createFileSystemWatcher('**/{plugin,package}.json');
    const onFile = (uri: vscode.Uri) => {
      if (!/[\\/]node_modules[\\/]/.test(uri.fsPath ?? uri.path)) this.rescanSoon();
    };
    this.subs = [
      watcher, watcher.onDidCreate(onFile), watcher.onDidDelete(onFile), watcher.onDidChange(onFile),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.rescanSoon()),
      vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('decky-toolkit.pluginDirName')) this.rescanSoon(); }),
    ];
    this.scan = this.refresh();
  }

  get plugins(): WorkspacePlugin[] {
    return this.list;
  }

  /** The current list once the scan in flight (if any) has finished. */
  ready(): Promise<WorkspacePlugin[]> {
    return this.scan;
  }

  private rescanSoon(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.refresh(), SCAN_DEBOUNCE_MS);
  }

  refresh(): Promise<WorkspacePlugin[]> {
    const override = vscode.workspace.getConfiguration('decky-toolkit').get<string>('pluginDirName', '');
    this.scan = (async () => {
      const found: WorkspacePlugin[] = [];
      for (const folder of vscode.workspace.workspaceFolders ?? []) {
        if (folder.uri.scheme && folder.uri.scheme !== 'file') continue;
        for (const root of await findPluginRoots(folder.uri.fsPath, 2)) {
          const p = await readWorkspacePlugin(root, override);
          if (p) found.push(p);
        }
      }
      if (!samePlugins(found, this.list)) {
        this.list = found;
        this.changed.fire();
      }
      return this.list;
    })();
    return this.scan;
  }

  /** Asks when there are several; explains and returns undefined when there are none. */
  async pick(placeHolder = 'Which plugin?', preferred?: string): Promise<WorkspacePlugin | undefined> {
    const plugins = await this.ready();
    if (plugins.length === 0) {
      void vscode.window.showWarningMessage(
        'Decky Toolkit: no workspace folder contains a plugin.json. Open your Decky plugin folder (File → Open Folder) to deploy, reload or tail it.');
      return undefined;
    }
    if (plugins.length === 1) return plugins[0];
    const items = plugins.map(p => ({ label: p.name, description: `${p.dir} · ${vscode.workspace.asRelativePath(p.root)}`, p }));
    items.sort((a, b) => Number(b.p.root === preferred) - Number(a.p.root === preferred));
    return (await vscode.window.showQuickPick(items, { placeHolder }))?.p;
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.subs.forEach(s => s.dispose());
    this.changed.dispose();
  }
}

export function pluginSummary(p: WorkspacePlugin): string {
  return p.version ? `${p.name} v${p.version}` : p.name;
}

export interface DeployRequest {
  full?: boolean;
  /** Triggered by a file change: no build, no prompts, status bar feedback only. */
  auto?: boolean;
  plugin?: WorkspacePlugin;
}

const PHASE_TEXT: Record<DeployPhase, string> = {
  building: 'building…', packaging: 'packaging…', uploading: 'uploading…', reloading: 'reloading the plugin…',
  restarting: 'waiting for the loader to restart…',
};

/** Deploy command, the status bar button, the first-detection prompt and auto-deploy on change. */
export class DeployController implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);
  private readonly subs: vscode.Disposable[];
  private running?: { plugin: WorkspacePlugin; phase?: DeployPhase; auto: boolean };
  private queued?: WorkspacePlugin;
  private lastRoot?: string;
  private prompted = false;
  private autoSubs: vscode.Disposable[] = [];
  private readonly timers = new Map<string, NodeJS.Timeout>();
  /** Per plugin root, once a deploy has put the device in step: later changes are pushed and reloaded in place. */
  private readonly live = new Map<string, LiveSync>();
  private readonly builders = new Map<string, ChildProcess>();
  private liveDevice?: string;

  constructor(
    private readonly conn: Connection,
    private readonly ws: PluginWorkspace,
    private readonly out: vscode.OutputChannel,
    private readonly afterDeploy: () => Promise<void>,
  ) {
    this.subs = [
      conn.onDidChange(() => { this.render(); this.maybePrompt(); }),
      // Live sessions hold the old device's client.
      conn.onDidChangeTarget(() => this.dropLive()),
      ws.onDidChange(() => { this.render(); this.maybePrompt(); this.armAutoDeploy(); }),
      vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('decky-toolkit.deploy.onChange')) this.armAutoDeploy(); }),
    ];
    this.render();
    this.armAutoDeploy();
  }

  static get autoDeployEnabled(): boolean {
    return vscode.workspace.getConfiguration('decky-toolkit').get<boolean>('deploy.onChange', false);
  }

  /** The plugin the status bar button deploys: the last one deployed, else the first found. */
  get target(): WorkspacePlugin | undefined {
    const list = this.ws.plugins;
    return list.find(p => p.root === this.lastRoot) ?? list[0];
  }

  get busy(): boolean {
    return !!this.running;
  }

  render(): void {
    const p = this.running?.plugin ?? this.target;
    const device = this.conn.connectedDevice;
    if (!p || !device) {
      this.item.hide();
      return;
    }
    if (this.running) {
      this.item.text = `$(sync~spin) Deploying ${p.name}`;
      this.item.tooltip = `Decky: deploying ${pluginSummary(p)} to ${device.name}${this.running.phase ? ` (${PHASE_TEXT[this.running.phase]})` : ''}`;
      this.item.command = undefined;
    } else {
      this.item.text = `$(rocket) Deploy ${p.name}`;
      this.item.tooltip = `Decky: build if needed, install ${pluginSummary(p)} as ~/homebrew/plugins/${p.dir} on ${device.name} and reload it` +
        `${DeployController.autoDeployEnabled ? '. Auto-deploy on change is on' : ''}`;
      this.item.command = 'decky-toolkit.deploy';
    }
    this.item.show();
  }

  private maybePrompt(): void {
    const p = this.target;
    const device = this.conn.connectedDevice;
    if (this.prompted || !p || !device) return;
    this.prompted = true;
    void vscode.window.showInformationMessage(`Decky plugin detected: ${p.name}. Deploy to ${device.name}?`, 'Deploy', 'Not now')
      .then(choice => { if (choice === 'Deploy') void this.deploy({ plugin: p }); });
  }

  async toggleAutoDeploy(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('decky-toolkit');
    const target = vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    const on = !DeployController.autoDeployEnabled;
    await cfg.update('deploy.onChange', on, target);
    void vscode.window.setStatusBarMessage(on
      ? 'Decky: auto-deploy on change is on (the first change deploys, later ones sync live)'
      : 'Decky: auto-deploy on change is off', 5000);
  }

  private armAutoDeploy(): void {
    this.autoSubs.forEach(s => s.dispose());
    this.autoSubs = [];
    this.dropLive();
    this.stopBuilders();
    if (!DeployController.autoDeployEnabled) return;
    const watchBuild = vscode.workspace.getConfiguration('decky-toolkit').get<boolean>('deploy.watchBuild', true);
    for (const p of this.ws.plugins) {
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(
        vscode.Uri.file(p.root), '{dist/**,py_modules/**,assets/**,defaults/**,main.py,plugin.json,package.json}'));
      const fire = (uri: vscode.Uri) => this.onPluginFileChanged(p, uri);
      this.autoSubs.push(w, w.onDidChange(fire), w.onDidCreate(fire));
      if (watchBuild) void this.startBuilder(p);
    }
  }

  private async startBuilder(p: WorkspacePlugin): Promise<void> {
    const child = await startWatchBuild(p.root, line => this.out.appendLine(`[build ${p.name}] ${line}`));
    if (!child) return;
    if (!DeployController.autoDeployEnabled || this.builders.has(p.root)) {
      stopWatchBuild(child);
      return;
    }
    this.builders.set(p.root, child);
    this.out.appendLine(`Started the watch build of ${p.name} (package.json "watch" script)`);
    child.once('exit', () => { if (this.builders.get(p.root) === child) this.builders.delete(p.root); });
  }

  private stopBuilders(): void {
    this.builders.forEach(stopWatchBuild);
    this.builders.clear();
  }

  private dropLive(): void {
    this.live.forEach(l => l.dispose());
    this.live.clear();
  }

  /** After a deploy: devices with live sync take later changes as pushes and in-place reloads. */
  private async startLive(p: WorkspacePlugin, dir: string): Promise<void> {
    const client = this.conn.connectedDevice && this.conn.authedClient();
    if (!client || !DeployController.autoDeployEnabled) return;
    const health = await client.health().catch(() => undefined);
    if (!health || outdatedDevice(health)) return;
    this.live.get(p.root)?.dispose();
    const sync = new LiveSync(client, { ...p, dir }, {
      log: line => this.out.appendLine(line),
      fullDeploy: async () => { await this.deploy({ auto: true, plugin: p }); },
      onSynced: step => {
        if (step.error) {
          vscode.window.setStatusBarMessage(`$(warning) Decky: live sync of ${p.name} failed (see output)`, 8000);
        } else if (step.result && !step.result.scheduled) {
          const errs = step.result.errors?.length ? ` with ${step.result.errors.length} error(s)` : '';
          vscode.window.setStatusBarMessage(`$(check) Decky: reloaded ${p.name} (${step.mode}) in ${step.totalMs} ms${errs}`, 5000);
          if (errs) this.out.show(true);
        }
      },
    });
    await sync.seed();
    this.live.set(p.root, sync);
    this.liveDevice = this.conn.connectedDevice?.name;
    this.out.appendLine(`Live sync on for ${p.name}: changes now reload in place on ${this.liveDevice ?? 'the device'}`);
  }

  private onPluginFileChanged(p: WorkspacePlugin, uri: vscode.Uri): void {
    if (!this.conn.connectedDevice) return;
    const sync = this.live.get(p.root);
    if (sync && !this.running) {
      sync.notify(path.relative(p.root, uri.fsPath));
      return;
    }
    clearTimeout(this.timers.get(p.root));
    this.timers.set(p.root, setTimeout(() => {
      this.timers.delete(p.root);
      const r = this.running;
      // A build in progress writes dist/index.js; that deploy stages it anyway.
      if (r?.plugin.root === p.root && (r.phase === undefined || r.phase === 'building')) return;
      if (r) {
        this.queued = p;
        return;
      }
      void this.deploy({ auto: true, plugin: p });
    }, AUTO_DEPLOY_DEBOUNCE_MS));
  }

  async deploy(req: DeployRequest = {}): Promise<DeployStep | undefined> {
    if (this.running) {
      if (req.auto) this.queued = req.plugin;
      else void vscode.window.showInformationMessage(`Decky Toolkit: already deploying ${this.running.plugin.name}.`);
      return undefined;
    }
    const client = req.auto ? (this.conn.connectedDevice && this.conn.authedClient()) : await this.conn.client();
    if (!client) return undefined;
    const p = req.plugin ?? await this.ws.pick('Deploy which plugin?', this.lastRoot);
    if (!p) return undefined;
    this.lastRoot = p.root;
    const device = this.conn.connectedDevice?.name ?? client.address.host;
    const build: BuildMode = req.auto ? 'never' : vscode.workspace.getConfiguration('decky-toolkit').get<BuildMode>('deploy.build', 'auto');
    this.running = { plugin: p, auto: !!req.auto };
    this.render();
    this.out.appendLine(`\n=== ${req.auto ? 'Auto-deploying' : 'Deploying'} ${pluginSummary(p)} to ${device}` +
      ` (${req.full ? 'full loader restart' : 'fast'}, build ${build}, ${new Date().toLocaleTimeString()})`);
    if (!req.auto) this.out.show(true);
    const ac = new AbortController();
    try {
      const step = await vscode.window.withProgress(
        {
          location: req.auto ? vscode.ProgressLocation.Window : vscode.ProgressLocation.Notification,
          title: `Deploying ${p.name}`,
          cancellable: !req.auto,
        },
        (progress, token) => {
          token?.onCancellationRequested(() => ac.abort(new vscode.CancellationError()));
          return deployPlugin(client, p, {
            restart: req.full ? 'loader' : undefined, build, signal: ac.signal,
            log: line => this.out.appendLine(line),
            onPhase: phase => {
              this.running!.phase = phase;
              progress.report({ message: PHASE_TEXT[phase] });
              this.render();
            },
          });
        });
      this.report(p, step, !!req.auto);
      if (!step.confirm || step.confirm.confirmed) await this.startLive(p, step.dir).catch(() => undefined);
      return step;
    } catch (e) {
      if (ac.signal.aborted) {
        this.out.appendLine('Cancelled.');
        return undefined;
      }
      const why = e instanceof BuildError ? `build failed: ${e.message}` : describeError(e);
      this.out.appendLine(`Deploy failed: ${why}`);
      void vscode.window.showErrorMessage(`Decky Toolkit deploy failed: ${why}`, 'Show output')
        .then(c => { if (c) this.out.show(true); });
      return undefined;
    } finally {
      this.running = undefined;
      this.render();
      await this.afterDeploy().catch(() => undefined);
      const next = this.queued;
      this.queued = undefined;
      if (next && DeployController.autoDeployEnabled) void this.deploy({ auto: true, plugin: next });
    }
  }

  private report(p: WorkspacePlugin, step: DeployStep, auto: boolean): void {
    const secs = (step.totalMs / 1000).toFixed(1);
    const how = step.via === 'loader' ? ' (loader restarted)' : '';
    this.out.appendLine(`Deployed ${p.name} in ${secs} s${how}`);
    if (step.confirm && !step.confirm.confirmed) {
      void vscode.window.showWarningMessage(
        `Decky Toolkit: installed ${p.name}, but could not confirm the reload: ${step.confirm.detail}.`, 'Show output', 'Deploy (full restart)')
        .then(c => {
          if (c === 'Show output') this.out.show(true);
          else if (c) void this.deploy({ full: true, plugin: p });
        });
      return;
    }
    const msg = `Deployed ${p.name} in ${secs} s${how}`;
    if (auto) vscode.window.setStatusBarMessage(`$(check) ${msg}`, 5000);
    else void vscode.window.showInformationMessage(`Decky Toolkit: ${msg}.`);
  }

  dispose(): void {
    this.timers.forEach(t => clearTimeout(t));
    this.dropLive();
    this.stopBuilders();
    this.autoSubs.forEach(s => s.dispose());
    this.subs.forEach(s => s.dispose());
    this.item.dispose();
  }
}
