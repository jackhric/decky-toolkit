import { promises as fs } from 'fs';
import { isIPv6 } from 'net';
import { hostname } from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { parseArgs } from 'util';
import type { RestartMode } from '@decky-toolkit/client/api';
import { DeckyClient } from '@decky-toolkit/client/client';
import { DEFAULT_PORT, DiscoveredDevice, scanNetwork } from '@decky-toolkit/client/discovery';
import * as identityFile from '@decky-toolkit/client/identity';
import { requestApproval } from '@decky-toolkit/client/pairing';
import { RESTART_MODES, StatusReport, acceptsPairing, deploy, deviceStatus, explain, pairedClient } from './device';
import { McpServer } from './mcp';
import { VERSION } from './version';

const MCP_ADD = 'claude mcp add decky -- npx -y decky-toolkit mcp';

const HELP = `decky-toolkit ${VERSION}: pair with a Steam Deck running the Decky Toolkit plugin and use it from the shell or a coding agent.

Usage: decky-toolkit <command> [options]

Commands:
  pair [host[:port]] [--name <name>]   Pair this machine with a device (no host: search the local network)
  status [--json]                      Show the paired device and whether it answers
  mcp                                  Run an MCP server over stdio with the device's tools
  deploy [dir] [--restart <mode>]      Install the Decky plugin in dir (default: .) on the device
  call <tool> [json-args] [--out <file>]
                                       Call one of the device's tools; images are saved to a file
  forget                               Forget the pairing on this machine

Options:
  --restart none|plugin|loader         What deploy reloads (default: picked from the plugin)
  -h, --help                           Show this help
  -v, --version                        Show the version

Add it to Claude Code:
  ${MCP_ADD}
`;

const OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
  json: { type: 'boolean' },
  name: { type: 'string' },
  restart: { type: 'string' },
  out: { type: 'string', short: 'o' },
} as const;

const COMMANDS: Record<string, { options: string[]; maxArgs: number }> = {
  pair: { options: ['name'], maxArgs: 1 },
  status: { options: ['json'], maxArgs: 0 },
  mcp: { options: [], maxArgs: 0 },
  deploy: { options: ['restart'], maxArgs: 1 },
  call: { options: ['out'], maxArgs: 2 },
  forget: { options: [], maxArgs: 0 },
};

class UsageError extends Error {}

const out = (s: string) => process.stdout.write(s.endsWith('\n') ? s : s + '\n');
const err = (s: string) => process.stderr.write(s.endsWith('\n') ? s : s + '\n');

export function parseHostPort(s: string): { host: string; port: number } {
  const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(s) ?? /^([^:\s]+)(?::(\d+))?$/.exec(s);
  const [host, portText] = m ? [m[1], m[2]] : isIPv6(s) ? [s, undefined] : [undefined, undefined];
  if (!host) throw new UsageError(`not a host or host:port: ${s}`);
  const port = portText === undefined ? DEFAULT_PORT : Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new UsageError(`not a port: ${portText}`);
  return { host, port };
}

/** SIGINT aborts the returned signal while `fn` runs; a second Ctrl-C exits at once. */
async function cancellable<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ac = new AbortController();
  const onInt = () => {
    if (ac.signal.aborted) process.exit(130);
    ac.abort(new Error('cancelled'));
  };
  process.on('SIGINT', onInt);
  try {
    return await fn(ac.signal);
  } finally {
    process.off('SIGINT', onInt);
  }
}

async function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string>((resolve, reject) => {
      rl.question(question, resolve);
      rl.on('close', () => reject(new UsageError('no answer on stdin')));
    });
  } finally {
    rl.close();
  }
}

async function pickDevice(signal: AbortSignal): Promise<DiscoveredDevice | undefined> {
  out('Searching the local network for devices running Decky Toolkit…');
  const { devices, subnets } = await scanNetwork(signal);
  if (!devices.length) {
    err(`No device found${subnets.length ? ` on ${subnets.join(', ')}` : ''}. Check that the Deck is on, Decky Toolkit is installed, `
      + 'and both are on the same network, or pass its address: decky-toolkit pair <host>[:port]');
    return undefined;
  }
  if (devices.length === 1) return devices[0];
  devices.forEach((d, i) => out(`  ${i + 1}. ${d.name}  ${d.host}:${d.port}  (Decky Toolkit ${d.version})`));
  const answer = (await ask(`Which device? [1-${devices.length}] `)).trim();
  const n = Number(answer);
  if (!Number.isInteger(n) || n < 1 || n > devices.length) throw new UsageError(`not a number from 1 to ${devices.length}: ${answer}`);
  return devices[n - 1];
}

async function pair(target: string | undefined, clientName: string): Promise<number> {
  return cancellable(async signal => {
    let address: { host: string; port: number };
    let mdnsName: string | undefined;
    if (target) {
      address = parseHostPort(target);
    } else {
      let found;
      try {
        found = await pickDevice(signal);
      } catch (e) {
        if (signal.aborted) { err('Cancelled.'); return 1; }
        throw e;
      }
      if (!found) return 2;
      address = { host: found.host, port: found.port };
      mdnsName = found.name;
    }
    const anon = new DeckyClient(address);
    let health;
    try {
      health = await anon.health(5000);
    } catch (e) {
      err(`Cannot pair: ${explain(e, address)}`);
      return 1;
    }
    const name = health.hostname?.split('.')[0] || mdnsName || address.host;
    const where = `${name} (${address.host}:${address.port})`;
    const existing = await identityFile.read();
    if (existing && identityFile.sameDevice(existing.device, address)) {
      const ok = await acceptsPairing(new DeckyClient(address, identityFile.toIdentity(existing))).catch(() => false);
      if (ok) {
        out(`Already paired with ${where}.`);
        return 0;
      }
    } else if (existing) {
      out(`This replaces the pairing with ${existing.device.name} (${existing.device.host}:${existing.device.port}).`);
    }
    let lost = false;
    const outcome = await requestApproval(anon, {
      clientName,
      clientKind: 'mcp',
      signal,
      onCode: code => out(`Approve on the device · code ${code}\nWaiting for approval in the Decky Toolkit panel (Ctrl-C cancels)…`),
      onPoll: () => { lost = false; },
      onLostContact: e => {
        if (!lost) err(`Lost contact with the device (${explain(e)}); retrying…`);
        lost = true;
      },
    });
    if (outcome === 'cancelled') { err('Cancelled; the request was withdrawn.'); return 1; }
    if (outcome === 'denied') { err('The request was denied on the device.'); return 1; }
    if (outcome === 'unsupported') { err('The device runs an older Decky Toolkit without this kind of pairing; update it.'); return 1; }
    if (outcome === 'mismatch') { err('The code the device showed does not match this request; something on the network altered it. Not paired.'); return 1; }
    if ('error' in outcome) { err(`Pairing failed: ${outcome.error}`); return 1; }
    await identityFile.write({
      version: 1,
      device: { host: address.host, port: address.port, name, ...(health.device_id ? { deviceId: health.device_id } : {}) },
      ...outcome.identity,
    });
    out(`Paired with ${where}.\nUse it from Claude Code:  ${MCP_ADD}`);
    return 0;
  });
}

function printStatus(s: StatusReport): void {
  const rows: [string, string][] = [['Identity', s.identity ? s.identityFile : `none (${s.identityFile})`]];
  if (s.device) rows.push(['Device', `${s.device.name} (${s.device.host}:${s.device.port})`]);
  if (s.identity) rows.push(['Reachable', s.reachable ? 'yes' : 'no']);
  if (s.plugin) rows.push(['Plugin', `${s.plugin.name} ${s.plugin.version}, api ${s.plugin.apiVersion}, ${s.plugin.tools} tools`]);
  if (s.reachable) rows.push(['Paired', s.paired ? 'yes' : 'no']);
  for (const [k, v] of rows) out(`${k.padEnd(10)} ${v}`);
  if (s.error) out(`\n${s.error[0].toUpperCase()}${s.error.slice(1)}.`);
}

function extensionFor(mime: string): string {
  return mime === 'image/png' ? '.png' : mime === 'image/webp' ? '.webp' : '.jpg';
}

async function call(tool: string, rawArgs: string | undefined, outFile: string | undefined): Promise<number> {
  let args: Record<string, unknown> = {};
  if (rawArgs !== undefined) {
    try {
      args = JSON.parse(rawArgs);
    } catch (e) {
      throw new UsageError(`json-args is not valid JSON: ${(e as Error).message}`);
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new UsageError('json-args must be a JSON object');
  }
  const { client, file } = await pairedClient();
  let result;
  try {
    result = await client.callTool(tool, args, 300000);
  } catch (e) {
    err(`${tool}: ${explain(e, file.device)}`);
    return 1;
  }
  const images = result.content.filter(c => c.type === 'image') as { data: string; mimeType: string }[];
  const write = result.isError ? err : out;
  for (const c of result.content) if (c.type === 'text') write(String((c as { text: unknown }).text));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (const [i, img] of images.entries()) {
    const ext = extensionFor(img.mimeType);
    let target = outFile ?? `${tool}-${stamp}${ext}`;
    if (images.length > 1) target = target.replace(/(\.[^./]+)?$/, m => `-${i + 1}${m}`);
    const data = Buffer.from(img.data, 'base64');
    await fs.writeFile(target, data);
    out(`Saved ${img.mimeType} to ${path.resolve(target)} (${(data.length / 1024).toFixed(0)} KiB)`);
  }
  return result.isError ? 1 : 0;
}

async function forget(): Promise<number> {
  const existing = await identityFile.read();
  if (!existing && !(await identityFile.exists())) {
    out(`Not paired; nothing to forget (${identityFile.identityPath()}).`);
    return 0;
  }
  await identityFile.remove();
  const which = existing ? ` with ${existing.device.name} (${existing.device.host}:${existing.device.port})` : '';
  out(`Forgot the pairing${which} on this machine. The device keeps listing this client until you remove it in the Decky Toolkit panel there.`);
  return 0;
}

async function runCommand(command: string, positionals: string[], values: Record<string, string | boolean | undefined>): Promise<number> {
  switch (command) {
    case 'pair':
      return pair(positionals[0], typeof values.name === 'string' && values.name.trim() ? values.name.trim() : `CLI on ${hostname()}`);
    case 'status': {
      const s = await deviceStatus();
      if (values.json) out(JSON.stringify(s, null, 2));
      else printStatus(s);
      return s.paired ? 0 : 1;
    }
    case 'mcp': {
      // stdout carries only JSON-RPC; anything a dependency prints goes to stderr.
      console.log = console.info = console.debug = console.error;
      await new McpServer(s => process.stderr.write(s)).serve(process.stdin, process.stdout);
      return 0;
    }
    case 'deploy': {
      const restart = values.restart as string | undefined;
      if (restart !== undefined && !RESTART_MODES.includes(restart as RestartMode)) throw new UsageError(`--restart must be one of ${RESTART_MODES.join(', ')}`);
      try {
        const r = await deploy(positionals[0] ?? '.', restart as RestartMode | undefined, s => process.stdout.write(s));
        out(`Deployed ${r.plugin.name}${r.listed.version ? ` ${r.listed.version}` : ''} to ${r.device.host} in ${(r.totalMs / 1000).toFixed(1)} s `
          + `(upload ${r.uploadMs} ms, ready ${r.readyMs} ms); the device answers and lists ${r.plugin.dir}.`);
        return r.reloaded === false ? 1 : 0;
      } catch (e) {
        err(`Deploy failed: ${explain(e)}`);
        return 1;
      }
    }
    case 'call':
      if (!positionals[0]) throw new UsageError('call needs a tool name');
      return call(positionals[0], positionals[1], values.out as string | undefined);
    case 'forget':
      return forget();
  }
  throw new UsageError(`unknown command: ${command}`);
}

export async function main(argv: string[]): Promise<number> {
  try {
    let parsed;
    try {
      parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
    } catch (e) {
      throw new UsageError((e as Error).message);
    }
    const { values, positionals } = parsed;
    if (values.version) { out(VERSION); return 0; }
    const [command, ...rest] = positionals;
    if (values.help || !command) {
      (command || values.help ? out : err)(HELP);
      return values.help ? 0 : 2;
    }
    const spec = COMMANDS[command];
    if (!spec) throw new UsageError(`unknown command: ${command}`);
    const extra = Object.keys(values).filter(k => values[k as keyof typeof values] !== undefined && !spec.options.includes(k));
    if (extra.length) throw new UsageError(`${command} does not take --${extra[0]}`);
    if (rest.length > spec.maxArgs) throw new UsageError(`too many arguments for ${command}`);
    return await runCommand(command, rest, values);
  } catch (e) {
    if (e instanceof UsageError) {
      err(`decky-toolkit: ${e.message}\nRun \`decky-toolkit --help\` for usage.`);
      return 2;
    }
    err(`decky-toolkit: ${explain(e)}`);
    return 1;
  }
}
