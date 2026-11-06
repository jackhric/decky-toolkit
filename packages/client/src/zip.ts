import { promisify } from 'util';
import { deflateRaw } from 'zlib';

const deflate = promisify(deflateRaw);
const DEFLATE_CONCURRENCY = 4;

export interface ZipEntry {
  /** Forward-slash path inside the archive; directories end with `/`. */
  name: string;
  data?: Uint8Array;
  mtime?: Date;
  mode?: number;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** Deflated when that is smaller; zlib runs on the thread pool, a few entries at a time. */
async function compress(entries: ZipEntry[]): Promise<{ raw: Uint8Array; body: Uint8Array; method: number }[]> {
  const out: { raw: Uint8Array; body: Uint8Array; method: number }[] = new Array(entries.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < entries.length; i = next++) {
      const e = entries[i];
      const raw = e.name.endsWith('/') ? new Uint8Array(0) : e.data ?? new Uint8Array(0);
      const deflated = raw.length > 64 ? await deflate(raw) : undefined;
      out[i] = deflated && deflated.length < raw.length ? { raw, body: deflated, method: 8 } : { raw, body: raw, method: 0 };
    }
  };
  await Promise.all(Array.from({ length: DEFLATE_CONCURRENCY }, worker));
  return out;
}

/** Minimal ZIP writer (stored or deflate, no ZIP64), enough for plugin bundles. */
export async function createZip(entries: ZipEntry[]): Promise<Buffer> {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  const bodies = await compress(entries);

  for (const [i, e] of entries.entries()) {
    const name = Buffer.from(e.name, 'utf8');
    const isDir = e.name.endsWith('/');
    const { raw, body, method } = bodies[i];
    const crc = crc32(raw);
    const { time, date } = dosDateTime(e.mtime ?? new Date());
    // Bit 11: names are UTF-8.
    const flags = 0x0800;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, Buffer.from(body.buffer, body.byteOffset, body.byteLength));

    const mode = e.mode ?? (isDir ? 0o40755 : 0o100644);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    // Made by: Unix (3), so unzip honours the mode in external attributes.
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(((mode << 16) | (isDir ? 0x10 : 0)) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + body.length;
  }

  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}
