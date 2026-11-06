import * as vscode from 'vscode';
import type { SavedDevice } from './connection';
import { DiscoveredDevice, discoveryTimings, scanNetwork } from '@decky-toolkit/client/discovery';

export * from '@decky-toolkit/client/discovery';

export interface DiscoveryChange {
  found: DiscoveredDevice[];
  lost: DiscoveredDevice[];
}

export interface ScanSummary {
  at: number;
  ms: number;
  manual: boolean;
  subnets: string[];
  probes: number;
  truncated: boolean;
  mdnsAnswers: number;
}

function isSaved(d: DiscoveredDevice, saved: SavedDevice[]): boolean {
  const names = new Set([d.host, d.hostname, d.hostname?.split('.')[0], d.hostname && `${d.hostname.split('.')[0]}.local`]
    .filter((x): x is string => !!x).map(x => x.toLowerCase()));
  return saved.some(s => s.port === d.port && names.has(s.host.toLowerCase()));
}

/**
 * Finds Decky Toolkit devices on the local network that are not saved yet. Scans only when asked
 * (`start` when the Devices view opens, at most once per `minRescanMs`, or `rescan`), never in the background.
 */
export class DeviceDiscovery implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<DiscoveryChange>();
  /** Unsaved devices that appeared or disappeared with the last scan. */
  readonly onDidChange = this.changed.event;
  private readonly stateChanged = new vscode.EventEmitter<void>();
  /** Scanning started/stopped, the setting or the saved list changed: re-read `devices`/`scanning`. */
  readonly onDidChangeState = this.stateChanged.event;
  private found: DiscoveredDevice[] = [];
  private abort?: AbortController;
  private last?: ScanSummary;
  private readonly sub: vscode.Disposable;

  constructor(private readonly saved: () => SavedDevice[]) {
    this.sub = vscode.workspace.onDidChangeConfiguration(e => {
      if (!e.affectsConfiguration('decky-toolkit.discovery.enabled')) return;
      if (!this.enabled) {
        this.stop();
        this.found = [];
        this.last = undefined;
      }
      this.stateChanged.fire();
    });
  }

  get enabled(): boolean {
    return vscode.workspace.getConfiguration('decky-toolkit').get<boolean>('discovery.enabled', true);
  }

  get scanning(): boolean {
    return !!this.abort;
  }

  get lastScan(): ScanSummary | undefined {
    return this.last;
  }

  /** Found devices minus saved ones (matched by address or host name, and port). */
  get devices(): DiscoveredDevice[] {
    const saved = this.saved();
    return this.found.filter(d => !isSaved(d, saved));
  }

  /** The view opened: scan unless a scan is running or finished recently. */
  start(): void {
    if (!this.enabled || this.scanning) return;
    if (this.last && Date.now() - this.last.at < discoveryTimings.minRescanMs) return;
    void this.rescan(false);
  }

  /** Cancels a running scan and keeps the previous results. */
  stop(): void {
    if (!this.abort) return;
    this.abort.abort();
    this.abort = undefined;
    this.stateChanged.fire();
  }

  async rescan(manual = true): Promise<void> {
    if (!this.enabled) return;
    this.abort?.abort();
    const ac = new AbortController();
    this.abort = ac;
    this.stateChanged.fire();
    const t0 = Date.now();
    try {
      const r = await scanNetwork(ac.signal);
      if (ac.signal.aborted) return;
      const before = this.devices;
      this.found = r.devices;
      this.last = { at: Date.now(), ms: Date.now() - t0, manual, subnets: r.subnets, probes: r.probes, truncated: r.truncated, mdnsAnswers: r.mdnsAnswers };
      const after = this.devices;
      const found = after.filter(d => !before.some(b => b.key === d.key));
      const lost = before.filter(b => !after.some(d => d.key === b.key));
      if (found.length || lost.length) this.changed.fire({ found, lost });
    } finally {
      if (this.abort === ac) {
        this.abort = undefined;
        this.stateChanged.fire();
      }
    }
  }

  find(key: string): DiscoveredDevice | undefined {
    return this.found.find(d => d.key === key);
  }

  dispose(): void {
    this.abort?.abort();
    this.sub.dispose();
    this.changed.dispose();
    this.stateChanged.dispose();
  }
}
