import * as path from 'path';
import type { Health, RestartMode } from '@decky-toolkit/client/api';
import { DeckyClient, DeviceAddress, describeError, isConnectionError, isRejection, outdatedDevice } from '@decky-toolkit/client/client';
import { BUILD_MODES, BuildMode, DeployStep, deployPlugin, readWorkspacePlugin } from '@decky-toolkit/client/deploy';
import * as identityFile from '@decky-toolkit/client/identity';

export const PAIR_HINT = 'run `decky-toolkit pair`';

export class NotPairedError extends Error {
  constructor() {
    super(`this machine is not paired with a device; ${PAIR_HINT}`);
  }
}

/** A bad option value; the command line reports it as a usage error, the MCP server as a tool error. */
export class InvalidOption extends Error {}

export interface Paired {
  file: identityFile.IdentityFile;
  client: DeckyClient;
}

export function pairedWith(file: identityFile.IdentityFile): Paired {
  return { file, client: new DeckyClient({ host: file.device.host, port: file.device.port }, identityFile.toIdentity(file)) };
}

export async function pairedClient(): Promise<Paired> {
  const file = await identityFile.read();
  if (!file) throw new NotPairedError();
  return pairedWith(file);
}

type Where = DeviceAddress & { name?: string };

const describeDevice = (device?: Where) =>
  device ? `${device.name && device.name !== device.host ? `${device.name} ` : ''}at ${device.host}:${device.port}` : 'the device';
const rejected = (device?: Where) => `${describeDevice(device)} no longer accepts this machine's pairing; ${PAIR_HINT}`;

export function explain(e: unknown, device?: Where): string {
  if (e instanceof NotPairedError || e instanceof InvalidOption) return e.message;
  const where = describeDevice(device);
  if (isRejection(e)) return rejected(device);
  if (isConnectionError(e)) {
    const cause = (e as { cause?: { message?: string } }).cause?.message;
    return `cannot reach ${where}${cause ? ` (${cause})` : ''}; check that it is on and on the network, or ${PAIR_HINT} to pair with another device`;
  }
  return describeError(e);
}

/** Runs `fn` against the paired device; not being paired and a failing device both come back as one explained message. */
export async function onDevice<T>(paired: () => Promise<Paired>, fn: (p: Paired) => Promise<T>): Promise<{ value: T } | { error: string }> {
  let device: identityFile.IdentityDevice | undefined;
  try {
    const p = await paired();
    device = p.file.device;
    return { value: await fn(p) };
  } catch (e) {
    return { error: explain(e, device) };
  }
}

export interface StatusReport {
  identityFile: string;
  identity: boolean;
  device: identityFile.IdentityDevice | null;
  reachable: boolean;
  paired: boolean;
  plugin: { name: string; version: string; api: string[]; tools: number } | null;
  error?: string;
}

export async function deviceStatus(): Promise<StatusReport> {
  const file = await identityFile.read();
  let health: Health | undefined, healthError: unknown, check: Awaited<ReturnType<DeckyClient['acceptsIdentity']>> | undefined;
  if (file) {
    const { client } = pairedWith(file);
    [health, check] = await Promise.all([client.health(5000).catch(e => { healthError = e; return undefined; }), client.acceptsIdentity()]);
  }
  const paired = !!health && check === 'accepted';
  let error: string | undefined;
  if (!file) error = new NotPairedError().message;
  else if (!health) error = explain(healthError, file.device);
  else if (check === 'rejected') error = rejected(file.device);
  else if (check === 'unsupported') error = 'the device runs an older Decky Toolkit; update it';
  else if (typeof check === 'object') error = explain(check.unknown, file.device);
  else error = outdatedDevice(health);
  return {
    identityFile: identityFile.identityPath(),
    identity: !!file,
    device: file?.device ?? null,
    // A device that is not the one we paired with fails the pinned handshake, yet it answered.
    reachable: !!health || isRejection(healthError),
    paired,
    plugin: health ? { name: health.name, version: health.version, api: health.api ?? [], tools: health.tools } : null,
    ...(error ? { error } : {}),
  };
}

export const RESTART_MODES: RestartMode[] = ['none', 'plugin', 'loader'];

export function parseRestart(value: unknown): RestartMode | undefined {
  if (value === undefined || RESTART_MODES.includes(value as RestartMode)) return value as RestartMode | undefined;
  throw new InvalidOption(`restart must be one of ${RESTART_MODES.join(', ')}`);
}

export function parseBuild(value: unknown): BuildMode {
  if (value === undefined) return 'auto';
  if (BUILD_MODES.includes(value as BuildMode)) return value as BuildMode;
  throw new InvalidOption(`build must be one of ${BUILD_MODES.join(', ')}`);
}

export interface DeployResult {
  plugin: { name: string; dir: string; version: string | null };
  build: DeployStep['build'];
  restart: RestartMode;
  restarted: RestartMode;
  via: DeployStep['via'];
  files: string[];
  zipBytes: number;
  uploadMs: number;
  /** The loader journal showed the reload; null when none was expected (a loader restart, or `none` without the debug flag). */
  reloaded: boolean | null;
  reload?: string;
  nudged: boolean;
  totalMs: number;
  /** `pluginVersion` is Decky Toolkit's own, as it answered after a loader restart. */
  device: { host: string; port: number; pluginVersion?: string };
}

export async function deploy(dir: string, restart: RestartMode | undefined, build: BuildMode, log: (line: string) => void): Promise<DeployResult> {
  const root = path.resolve(dir);
  const [p, { file, client }] = await Promise.all([readWorkspacePlugin(root), pairedClient()]);
  if (!p) throw new Error(`${root} has no readable plugin.json`);
  const s = await deployPlugin(client, p, { restart, build, log });
  return {
    plugin: { name: p.name, dir: s.dir, version: s.installed.version ?? null },
    build: s.build, restart: s.restart, restarted: s.restarted, via: s.via, files: s.files, zipBytes: s.zipBytes, uploadMs: s.uploadMs,
    reloaded: s.confirm?.confirmed ?? null, ...(s.confirm ? { reload: s.confirm.detail } : {}), nudged: !!s.confirm?.nudged, totalMs: s.totalMs,
    device: { host: file.device.host, port: file.device.port, ...(s.health ? { pluginVersion: s.health.version } : {}) },
  };
}
