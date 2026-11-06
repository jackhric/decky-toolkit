// Maps bundle positions in a plugin's error stacks back to its sources, using the local `dist/index.js.map`.

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_VALUE = new Map([...B64].map((c, i) => [c, i]));

interface Segment { col: number; source: number; line: number; srcCol: number }

function decodeVlq(s: string): number[] {
  const out: number[] = [];
  let value = 0, shift = 0;
  for (const c of s) {
    const d = B64_VALUE.get(c);
    if (d === undefined) throw new Error(`bad VLQ character ${c}`);
    value += (d & 31) << shift;
    if (d & 32) {
      shift += 5;
    } else {
      out.push(value & 1 ? -(value >>> 1) : value >>> 1);
      value = shift = 0;
    }
  }
  return out;
}

export class SourceMap {
  private readonly lines: Segment[][] = [];
  private readonly sources: string[];

  constructor(map: { sources?: string[]; mappings?: string; sourceRoot?: string }) {
    this.sources = (map.sources ?? []).map(s => (map.sourceRoot ?? '') + s);
    let source = 0, line = 0, srcCol = 0;
    for (const text of (map.mappings ?? '').split(';')) {
      let col = 0;
      const segs: Segment[] = [];
      for (const raw of text.split(',')) {
        if (!raw) continue;
        const v = decodeVlq(raw);
        col += v[0];
        if (v.length < 4) continue;
        source += v[1];
        line += v[2];
        srcCol += v[3];
        segs.push({ col, source, line, srcCol });
      }
      this.lines.push(segs);
    }
  }

  /** 1-based line, 1-based column, as in a V8 stack frame. */
  lookup(line: number, column: number): { source: string; line: number; column: number } | undefined {
    const segs = this.lines[line - 1];
    if (!segs?.length) return undefined;
    let best: Segment | undefined;
    for (const s of segs) {
      if (s.col > column - 1) break;
      best = s;
    }
    best ??= segs[0];
    return { source: this.sources[best.source] ?? '?', line: best.line + 1, column: best.srcCol + 1 };
  }
}

/** Short, clickable source path: from `src/` on when the map's paths carry a prefix such as `decky://…/` or `../`. */
function shortSource(source: string): string {
  const s = decodeURIComponent(source).replace(/^decky:\/\/decky\/plugin\/[^/]+\//, '');
  const i = s.lastIndexOf('/src/');
  return i >= 0 ? s.slice(i + 1) : s.replace(/^(\.\.\/)+/, '');
}

/** Rewrites `…/dist/index.js?t=…:L:C` positions in `text` to `src/…:L:C` (the rest of the frame stays). */
export function mapStack(text: string, map: SourceMap): string {
  return text.replace(/\(?(?:https?|file):\/\/\S*?\/dist\/index\.js(?:\?[^:\s)]*)?:(\d+):(\d+)\)?/g, (whole, l, c) => {
    const hit = map.lookup(Number(l), Number(c));
    if (!hit) return whole;
    const pos = `${shortSource(hit.source)}:${hit.line}:${hit.column}`;
    return whole.startsWith('(') ? `(${pos})` : pos;
  });
}
