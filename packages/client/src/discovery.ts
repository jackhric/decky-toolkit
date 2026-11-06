import * as dgram from 'dgram';
import * as os from 'os';
import type { Health } from './api';
import { deviceFetch } from './transport';

export const SERVICE = '_decky-toolkit._tcp.local';
export const DEFAULT_PORT = 8765;
const MDNS_GROUP = '224.0.0.251';
const MDNS_PORT = 5353;
const TYPE = { A: 1, PTR: 12, TXT: 16, SRV: 33 } as const;
// Container, VM and VPN interfaces: nothing to find there, and their subnets are often wide.
const VIRTUAL_IF = /^(docker|br-|virbr|veth|vmnet|vboxnet|podman|cni|flannel|lxcbr|lxdbr|tailscale|tun|tap|wg|zt|utun|vEthernet)/i;
const MIN_SWEEP_PREFIX = 22;

export interface MdnsSocket {
  bind(port: number, cb: () => void): unknown;
  on(event: 'message', fn: (msg: Buffer, rinfo: { address: string }) => void): unknown;
  on(event: 'error', fn: (e: Error) => void): unknown;
  setMulticastInterface(address: string): void;
  setMulticastTTL(ttl: number): unknown;
  send(msg: Uint8Array, port: number, address: string, cb: (e: Error | null) => void): void;
  close(): void;
}

/** Mutable so tests can fake the network. */
export const discoveryHooks = {
  interfaces: (): NodeJS.Dict<os.NetworkInterfaceInfo[]> => os.networkInterfaces(),
  fetch: (url: string, init: RequestInit): Promise<Response> => deviceFetch(url, init),
  createSocket: (): MdnsSocket => dgram.createSocket({ type: 'udp4' }),
};

/** Mutable so tests can shorten them. */
export const discoveryTimings = { mdnsMs: 1500, probeTimeoutMs: 1200, concurrency: 128, maxProbes: 1024, minRescanMs: 60_000 };

export interface DiscoveredDevice {
  /** `host:port` */
  key: string;
  host: string;
  port: number;
  /** Short host name, else the mDNS instance name, else the address. */
  name: string;
  hostname?: string;
  deviceId?: string;
  os?: string;
  version: string;
  /** Client API versions it serves (`Health.api`); empty for a plugin too old for this client. */
  api: string[];
  /** Answers as `decky-mcp`, the name before the rename. */
  legacy: boolean;
  via: 'mdns' | 'sweep';
}

export interface LocalInterface {
  name: string;
  address: string;
  prefix: number;
}

export function usableInterfaces(ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>): LocalInterface[] {
  const out: LocalInterface[] = [];
  for (const [name, list] of Object.entries(ifaces)) {
    if (VIRTUAL_IF.test(name)) continue;
    for (const i of list ?? []) {
      if (i.family !== 'IPv4' || i.internal || i.address.startsWith('169.254.')) continue;
      out.push({ name, address: i.address, prefix: prefixOf(i.netmask) });
    }
  }
  return out;
}

function prefixOf(netmask: string): number {
  return ipToInt(netmask).toString(2).replace(/0+$/, '').length;
}

function ipToInt(ip: string): number {
  return ip.split('.').reduce((n, o) => (n << 8 >>> 0) + Number(o), 0) >>> 0;
}

function intToIp(n: number): string {
  return [24, 16, 8, 0].map(s => (n >>> s) & 255).join('.');
}

/** Hosts of each interface's subnet (same-link only; wider than /22 is skipped), own addresses excluded. */
export function sweepTargets(ifaces: LocalInterface[]): { subnets: string[]; hosts: string[] } {
  const own = new Set(ifaces.map(i => i.address));
  const subnets: string[] = [];
  const hosts = new Set<string>();
  for (const i of ifaces) {
    if (i.prefix < MIN_SWEEP_PREFIX || i.prefix > 30) continue;
    const size = 2 ** (32 - i.prefix);
    const net = (ipToInt(i.address) & ~(size - 1)) >>> 0;
    const cidr = `${intToIp(net)}/${i.prefix}`;
    if (subnets.includes(cidr)) continue;
    subnets.push(cidr);
    for (let h = net + 1; h < net + size - 1; h++) {
      const ip = intToIp(h);
      if (!own.has(ip)) hosts.add(ip);
    }
  }
  return { subnets, hosts: [...hosts] };
}

export function isToolkitHealth(h: unknown): h is Health {
  const x = h as Partial<Health> | null;
  return !!x && x.ok === true && (x.name === 'decky-toolkit' || x.name === 'decky-mcp');
}

async function probe(host: string, port: number, signal: AbortSignal): Promise<Health | undefined> {
  try {
    const res = await discoveryHooks.fetch(`https://${host}:${port}/health`, {
      signal: AbortSignal.any([AbortSignal.timeout(discoveryTimings.probeTimeoutMs), signal]), redirect: 'error',
    });
    if (!res.ok) return undefined;
    const text = await res.text();
    if (text.length > 64 * 1024) return undefined;
    const h: unknown = JSON.parse(text);
    return isToolkitHealth(h) ? h : undefined;
  } catch {
    return undefined;
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ---- mDNS (DNS-SD browse with legacy unicast queries: no need to bind 5353) ----

export function encodeQuery(name: string, type: number): Buffer {
  const labels = name.split('.').filter(Boolean).map(l => {
    const b = Buffer.from(l, 'utf8');
    return Buffer.concat([Buffer.from([b.length]), b]);
  });
  const header = Buffer.alloc(12);
  header.writeUInt16BE(1, 4);
  const tail = Buffer.alloc(5);
  tail.writeUInt16BE(type, 1);
  tail.writeUInt16BE(1, 3);
  return Buffer.concat([header, ...labels, tail]);
}

export type MdnsRecord =
  | { name: string; type: typeof TYPE.PTR; data: string }
  | { name: string; type: typeof TYPE.SRV; data: { port: number; target: string } }
  | { name: string; type: typeof TYPE.TXT; data: Record<string, string> }
  | { name: string; type: typeof TYPE.A; data: string };

function readName(buf: Buffer, start: number): [string, number] {
  const labels: string[] = [];
  let off = start, end = -1, jumps = 0;
  for (;;) {
    if (off >= buf.length) throw new Error('name past end');
    const len = buf[off];
    if (len === 0) {
      if (end < 0) end = off + 1;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      if (end < 0) end = off + 2;
      if (++jumps > 32) throw new Error('compression loop');
      off = ((len & 0x3f) << 8) | buf[off + 1];
      continue;
    }
    labels.push(buf.toString('utf8', off + 1, off + 1 + len));
    off += 1 + len;
  }
  return [labels.join('.'), end];
}

/** Answer, authority and additional records of the types DNS-SD needs; throws on a malformed packet. */
export function parseMessage(buf: Buffer): MdnsRecord[] {
  if (buf.length < 12) throw new Error('short packet');
  const qd = buf.readUInt16BE(4);
  const rr = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
  let off = 12;
  for (let i = 0; i < qd; i++) off = readName(buf, off)[1] + 4;
  const out: MdnsRecord[] = [];
  for (let i = 0; i < rr; i++) {
    const [name, after] = readName(buf, off);
    const type = buf.readUInt16BE(after);
    const len = buf.readUInt16BE(after + 8);
    const data = after + 10;
    if (data + len > buf.length) throw new Error('record past end');
    off = data + len;
    if (type === TYPE.PTR) out.push({ name, type, data: readName(buf, data)[0] });
    else if (type === TYPE.SRV) out.push({ name, type, data: { port: buf.readUInt16BE(data + 4), target: readName(buf, data + 6)[0] } });
    else if (type === TYPE.A && len === 4) out.push({ name, type, data: [...buf.subarray(data, data + 4)].join('.') });
    else if (type === TYPE.TXT) {
      const txt: Record<string, string> = {};
      for (let p = data; p < data + len;) {
        const s = buf.toString('utf8', p + 1, p + 1 + buf[p]);
        p += 1 + buf[p];
        const eq = s.indexOf('=');
        if (s) txt[eq < 0 ? s : s.slice(0, eq)] = eq < 0 ? '' : s.slice(eq + 1);
      }
      out.push({ name, type, data: txt });
    }
  }
  return out;
}

export interface MdnsService {
  instance: string;
  host: string;
  port: number;
  txt: Record<string, string>;
}

type Heard = MdnsRecord & { from: string };

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function assembleServices(heard: Heard[]): MdnsService[] {
  const out = new Map<string, MdnsService>();
  for (const p of heard) {
    if (p.type !== TYPE.PTR || !same(p.name, SERVICE)) continue;
    const instance = p.data;
    const srv = heard.find(r => r.type === TYPE.SRV && same(r.name, instance)) as Extract<Heard, { type: 33 }> | undefined;
    const txt = heard.find(r => r.type === TYPE.TXT && same(r.name, instance)) as Extract<Heard, { type: 16 }> | undefined;
    const addrs = srv ? heard.filter(r => r.type === TYPE.A && same(r.name, srv.data.target)).map(r => r.data as string) : [];
    // The responder's own source address is on our link; an A record may also list its other interfaces.
    const host = addrs.length === 0 || addrs.includes(p.from) ? p.from : addrs[0];
    const port = srv?.data.port ?? DEFAULT_PORT;
    const label = instance.endsWith(`.${SERVICE}`) ? instance.slice(0, -SERVICE.length - 1) : instance;
    out.set(`${host}:${port}`, { instance: label, host, port, txt: txt?.data ?? {} });
  }
  return [...out.values()];
}

/** Sends one PTR query per interface and collects answers for `ms`; never rejects. */
export function browseMdns(addresses: string[], ms: number, signal?: AbortSignal): Promise<{ services: MdnsService[]; answers: number }> {
  if (addresses.length === 0) return Promise.resolve({ services: [], answers: 0 });
  return new Promise(resolve => {
    const heard: Heard[] = [];
    let answers = 0;
    let sock: MdnsSocket;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      try { sock?.close(); } catch { /* already closed */ }
      resolve({ services: assembleServices(heard), answers });
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
    try {
      sock = discoveryHooks.createSocket();
    } catch {
      finish();
      return;
    }
    sock.on('error', finish);
    sock.on('message', (msg, rinfo) => {
      try {
        const recs = parseMessage(msg);
        if (recs.some(r => r.type === TYPE.PTR && same(r.name, SERVICE))) answers++;
        for (const r of recs) heard.push({ ...r, from: rinfo.address });
      } catch { /* not a DNS packet we understand */ }
    });
    const query = encodeQuery(SERVICE, TYPE.PTR);
    // Sends are chained: the multicast interface is socket state, read when the datagram goes out.
    const sendFrom = (i: number) => {
      if (done || i >= addresses.length) return;
      try {
        sock.setMulticastInterface(addresses[i]);
        sock.send(query, MDNS_PORT, MDNS_GROUP, () => sendFrom(i + 1));
      } catch {
        sendFrom(i + 1);
      }
    };
    sock.bind(0, () => {
      try { sock.setMulticastTTL(255); } catch { /* default TTL still reaches the link */ }
      sendFrom(0);
    });
  });
}

// ---- scan ----

export interface ScanResult {
  devices: DiscoveredDevice[];
  subnets: string[];
  probes: number;
  truncated: boolean;
  mdnsAnswers: number;
}

function toDevice(host: string, port: number, h: Health, via: DiscoveredDevice['via'], instance?: string): DiscoveredDevice {
  const short = h.hostname?.split('.')[0];
  return {
    key: `${host}:${port}`, host, port, name: short || instance || host,
    hostname: h.hostname, deviceId: h.device_id ?? undefined, os: h.os ?? undefined,
    version: h.version, api: h.api ?? [], legacy: h.name === 'decky-mcp', via,
  };
}

/** mDNS browse and a sweep of the local subnets run side by side; every hit is confirmed with `/health`. */
export async function scanNetwork(signal: AbortSignal): Promise<ScanResult> {
  const ifaces = usableInterfaces(discoveryHooks.interfaces());
  const { subnets, hosts } = sweepTargets(ifaces);
  const budget = discoveryTimings.maxProbes;
  const sweepHosts = hosts.slice(0, budget);
  const viaMdns = (async () => {
    const { services, answers } = await browseMdns(ifaces.map(i => i.address), discoveryTimings.mdnsMs, signal);
    const found = await mapLimit(services, discoveryTimings.concurrency, async s => {
      const h = await probe(s.host, s.port, signal);
      return h && toDevice(s.host, s.port, h, 'mdns', s.instance);
    });
    return { found, answers, probes: services.length };
  })();
  const viaSweep = mapLimit(sweepHosts, discoveryTimings.concurrency, async host => {
    const h = await probe(host, DEFAULT_PORT, signal);
    return h && toDevice(host, DEFAULT_PORT, h, 'sweep');
  });
  const [m, s] = await Promise.all([viaMdns, viaSweep]);
  const byKey = new Map<string, DiscoveredDevice>();
  const ids = new Set<string>();
  for (const d of [...m.found, ...s]) {
    if (!d || byKey.has(d.key)) continue;
    // One device seen on two addresses (Wi-Fi and Ethernet) is listed once.
    if (d.deviceId && ids.has(d.deviceId)) continue;
    if (d.deviceId) ids.add(d.deviceId);
    byKey.set(d.key, d);
  }
  return {
    devices: [...byKey.values()], subnets, probes: sweepHosts.length + m.probes,
    truncated: hosts.length > sweepHosts.length, mdnsAnswers: m.answers,
  };
}
