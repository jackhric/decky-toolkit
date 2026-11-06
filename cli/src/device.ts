import { promises as fs } from 'fs';
import * as path from 'path';
import type { Health, InstallResult, PluginInfo, RestartMode } from '@decky-toolkit/client/api';
import { DeckyClient, DeviceAddress, describeError, isConnectionError, isMissingRoute, isRejection, sleep } from '@decky-toolkit/client/client';
import * as identityFile from '@decky-toolkit/client/identity';
import { stagePlugin } from '@decky-toolkit/client/stage';

export const PAIR_HINT = 'run `decky-toolkit pair`';

export class NotPairedError extends Error {
  constructor() {
    super(`this machine is not paired with a device; ${PAIR_HINT}`);
  }
}

export async function pairedClient(): Promise<{ file: identityFile.IdentityFile; client: DeckyClient }> {
  const file = await identityFile.read();
  if (!file) throw new NotPairedError();
  return { file, client: new DeckyClient({ host: file.device.host, port: file.device.port }, identityFile.toIdentity(file)) };
}

export function explain(e: unknown, device?: DeviceAddress & { name?: string }): string {
  if (e instanceof NotPairedError) return e.message;
  const where = device ? `${device.name && device.name !== device.host ? `${device.name} ` : ''}at ${device.host}:${device.port}` : 'the device';
  if (isRejection(e)) return `${where} no longer accepts this machine's pairing; ${PAIR_HINT}`;
  if (isConnectionError(e)) {
    const cause = (e as { cause?: { message?: string } }).cause?.message;
    return `cannot reach ${where}${cause ? ` (${cause})` : ''}; check that it is on and on the network, or ${PAIR_HINT} to pair with another device`;
  }
  return describeError(e);
}

/** An authenticated route answers with anything but 401; `/stream/stats` 404s on devices without capture. */
export async function acceptsPairing(client: DeckyClient): Promise<boolean> {
  try {
    const res = await client.fetch('/stream/stats', { timeoutMs: 5000 });
    await res.text();
    return res.status !== 401 && res.status !== 403;
  } catch (e) {
    if (isRejection(e)) return false;
    throw e;
  }
}

export interface StatusReport {
  identityFile: string;
  identity: boolean;
  device: identityFile.IdentityDevice | null;
  reachable: boolean;
  paired: boolean;
  plugin: { name: string; version: string; apiVersion: number; tools: number } | null;
  error?: string;
}

export async function deviceStatus(): Promise<StatusReport> {
  const file = await identityFile.read();
  const report: StatusReport = {
    identityFile: identityFile.identityPath(), identity: !!file, device: file?.device ?? null, reachable: false, paired: false, plugin: null,
  };
  if (!file) return { ...report, error: new NotPairedError().message };
  let health: Health;
  try {
    health = await new DeckyClient(file.device).health(5000);
  } catch (e) {
    return { ...report, error: explain(e, file.device) };
  }
  report.reachable = true;
  report.plugin = { name: health.name, version: health.version, apiVersion: health.api_version, tools: health.tools };
  try {
    report.paired = await acceptsPairing((await pairedClient()).client);
    if (!report.paired) report.error = `the device no longer accepts this machine's pairing; ${PAIR_HINT}`;
  } catch (e) {
    report.error = explain(e, file.device);
  }
  return report;
}

export interface DeployResult {
  plugin: { name: string; dir: string; version: string | null };
  restart: RestartMode;
  restarted: RestartMode;
  files: string[];
  zipBytes: number;
  uploadMs: number;
  /** A new `Loaded <name>` line in the loader journal after a plugin reload; null when not checked (no reload asked, or no journal). */
  reloaded: boolean | null;
  readyMs: number;
  totalMs: number;
  device: { host: string; port: number; pluginVersion: string };
  listed: PluginInfo;
}

async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    const x = JSON.parse(await fs.readFile(file, 'utf8'));
    return x && typeof x === 'object' ? x : undefined;
  } catch {
    return undefined;
  }
}

async function journalShows(client: DeckyClient, before: string[], needle: string, timeoutMs: number): Promise<boolean> {
  const marker = before.at(-1);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const lines = await client.logTail({ source: 'loader', tail: 200 }).then(r => r.lines, () => [] as string[]);
    const i = marker === undefined ? -1 : lines.lastIndexOf(marker);
    if (lines.slice(i + 1).some(l => l.includes(needle))) return true;
    await sleep(250);
  }
  return false;
}

export const RESTART_MODES: RestartMode[] = ['none', 'plugin', 'loader'];

/**
 * Stages, uploads and waits until the device answers `/health` and lists the plugin. The install dir is the
 * one the device already uses for a plugin of this name (so a checkout under another folder name updates it),
 * else the folder name. Without `restart`: a new plugin restarts the loader (its file watcher never imports a
 * new dir), an installed one is reloaded. Not left to the watcher for `debug` plugins as the extension does: on
 * 2026-11-05 the watcher did not pick up a `restart=none` install of this repo's plugin at all.
 */
export async function deploy(dir: string, restart: RestartMode | undefined, log: (s: string) => void): Promise<DeployResult> {
  const t0 = Date.now();
  const root = path.resolve(dir);
  const meta = await readJson(path.join(root, 'plugin.json'));
  if (!meta) throw new Error(`${root} has no readable plugin.json`);
  const name = typeof meta.name === 'string' && meta.name ? meta.name : path.basename(root);
  const pkg = await readJson(path.join(root, 'package.json'));
  const { file, client } = await pairedClient();

  const existing = (await client.listPlugins()).find(p => p.name === name);
  const dirName = existing?.dir ?? path.basename(root);
  const mode: RestartMode = restart ?? (existing ? 'plugin' : 'loader');
  if (!existing && mode !== 'loader') log(`${name} is not installed on the device yet; it loads only after the next loader restart\n`);

  const { zip, files } = await stagePlugin(root, dirName);
  const journalBefore = mode === 'plugin' ? await client.logTail({ source: 'loader', tail: 5 }).then(r => r.lines, () => undefined) : undefined;
  log(`Staged ${files.join(', ')} (${(zip.length / 1024).toFixed(0)} KiB) for ${dirName}\n`);
  const u0 = Date.now();
  let result: InstallResult;
  try {
    result = await client.installPlugin(zip, `${dirName}.zip`, mode);
  } catch (e) {
    if (isMissingRoute(e)) throw new Error('the Decky Toolkit plugin on the device is too old to install plugins; update it');
    throw e;
  }
  const uploadMs = Date.now() - u0;
  log(`Installed ${result.installed.name} ${result.installed.version ?? ''} in ${result.installed.dir}; restart: ${result.restarted}\n`);

  const r0 = Date.now();
  let reloaded: boolean | null = null;
  // The old backend keeps answering until the loader swaps it, so `/health` alone cannot tell a reload happened.
  if (journalBefore && result.restarted === 'plugin') {
    reloaded = await journalShows(client, journalBefore, `[loader][INFO]: Loaded ${name}`, 15000);
    log(reloaded ? `Decky Loader reloaded ${name}\n` : `No reload of ${name} in the loader journal within 15 s\n`);
  }
  if (result.restarted === 'loader') {
    log('Waiting for the loader to restart\n');
    await client.waitForRestart(90000);
  }
  let health: Health | undefined;
  let listed: PluginInfo | undefined;
  let last: unknown;
  while (Date.now() - r0 < 90000) {
    try {
      health = await client.health(3000);
      listed = (await client.listPlugins()).find(p => p.dir === result.installed.dir);
      if (health.ok && listed) break;
    } catch (e) {
      last = e;
    }
    await sleep(1000);
  }
  if (!health?.ok || !listed) throw new Error(`the device did not list ${result.installed.dir} within 90 s${last ? ` (${describeError(last)})` : ''}`);
  return {
    plugin: { name, dir: result.installed.dir, version: typeof pkg?.version === 'string' ? pkg.version : null },
    restart: mode, restarted: result.restarted, files, zipBytes: zip.length, uploadMs, reloaded, readyMs: Date.now() - r0, totalMs: Date.now() - t0,
    device: { host: file.device.host, port: file.device.port, pluginVersion: health.version }, listed,
  };
}
