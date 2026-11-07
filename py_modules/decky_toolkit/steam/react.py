"""Read-only looks at Steam's React: webpack exports by source text, the fiber tree around an element, and the
`__deckyPatch` chains that @decky/ui's afterPatch/beforePatch/replacePatch leave on a patched function.

`find` uses @decky/ui's module list (`window.DFL.modules`, every webpack module, loaded once by DFL) in SharedJSContext.
`tree` and `patches` with a selector run in the target window, which sees React's `__reactFiber$*` keys on its nodes.
A wrapper is ours when its handler carries `__deckyToolkit` (the tweak name), set by the patch helper in `src/steam/`.
"""
import json
from typing import Any, Awaitable, Callable

from . import cdp
from .ui import QUERY_TARGET

Evaluate = Callable[[str | None, str], Awaitable[Any]]
MAX_FIND = 50
MAX_UP = 40
MAX_DOWN = 6
MAX_DOWN_NODES = 80

# Shared helpers, defined inside each evaluation's function scope.
_HELPERS = r"""
const TAGS = {0: 'function', 1: 'class', 3: 'root', 4: 'portal', 5: 'host', 6: 'text', 7: 'fragment', 8: 'mode',
  9: 'consumer', 10: 'provider', 11: 'forwardRef', 12: 'profiler', 13: 'suspense', 14: 'memo', 15: 'memo', 16: 'lazy'};
const short = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);
const srcOf = (fn) => { try { return typeof fn === 'function' ? Function.prototype.toString.call(fn) : ''; } catch (e) { return ''; } };
const isMemo = (x) => x && x.$$typeof === Symbol.for('react.memo');
const isForwardRef = (x) => x && x.$$typeof === Symbol.for('react.forward_ref');
const kindOf = (x) => isMemo(x) ? 'memo' : isForwardRef(x) ? 'forwardRef'
  : typeof x === 'function' ? (x.prototype && x.prototype.isReactComponent ? 'class' : 'function') : null;
// The function a component's renders go through, plus the object/property a patch would sit on.
const holder = (x) => isMemo(x) ? (isForwardRef(x.type) ? [x.type, 'render'] : [x, 'type'])
  : isForwardRef(x) ? [x, 'render'] : null;
const chain = (fn) => {
  const layers = [];
  for (let f = fn, i = 0; f && f.__deckyPatch && i < 50; i++) {
    const p = f.__deckyPatch, h = p.handler;
    layers.push({ ours: (h && h.__deckyToolkit) || null, handler: short(srcOf(h).replace(/\s+/g, ' '), 100) });
    f = p.original;
  }
  return layers;
};
const origOf = (fn) => { let f = fn; for (let i = 0; f && f.__deckyPatch && i < 50; i++) f = f.__deckyPatch.original; return f; };
const fiberOf = (el) => { const k = el && Object.keys(el).find((k) => k.startsWith('__reactFiber$')); return k ? el[k] : null; };
const isBoundary = (t) => typeof t === 'function' && !!(t.getDerivedStateFromError || (t.prototype && t.prototype.componentDidCatch));
const nameOf = (t) => { const x = isMemo(t) ? t.type : t; const r = isForwardRef(x) ? x.render : x;
  return (t && t.displayName) || (x && x.displayName) || (r && r.displayName) || (r && r.name) || null; };
"""

_FIND_JS = r"""(() => {
%s
  const D = window.DFL;
  if (!D || !D.modules) return { error: 'window.DFL.modules is missing (@decky/ui not loaded in SharedJSContext)' };
  const needles = %s, limit = %d, seen = new Set(), matches = [];
  let total = 0;
  for (const [id, m] of D.modules) {
    if (!m) continue;
    for (const [base, mod] of [['', m], ['default.', m.default]]) {
      if (!mod || (typeof mod !== 'object' && typeof mod !== 'function') || (base && mod === m)) continue;
      for (const key of Object.keys(mod)) {
        let x;
        try { x = mod[key]; } catch (e) { continue; }
        const kind = kindOf(x);
        if (!kind || seen.has(x)) continue;
        seen.add(x);
        const h = holder(x), fn = h ? h[0][h[1]] : x;
        const src = srcOf(origOf(fn));
        if (!needles.every((n) => src.includes(n))) continue;
        total++;
        if (matches.length >= limit) continue;
        const at = src.indexOf(needles[0]);
        matches.push({ ref: id + ':' + base + key, kind, name: nameOf(x), length: src.length,
          excerpt: (at > 80 ? '…' : '') + src.slice(Math.max(0, at - 80), at + 160).replace(/\s+/g, ' ') + (at + 160 < src.length ? '…' : ''),
          patched: chain(fn).length });
      }
    }
  }
  return { total, matches };
})()"""

_RESOLVE_JS = r"""
  const ref = %s, at = ref.indexOf(':'), D = window.DFL;
  const m = D && D.modules && D.modules.get(ref.slice(0, at));
  let path = ref.slice(at + 1).split('.'), x = m;
  for (const p of path) x = x && x[p];
  if (at < 0 || !kindOf(x)) return { error: 'no component at ref ' + ref + ' (refs come from ui_react find and change when Steam updates)' };
"""

_PATCHES_REF_JS = r"""(() => {
%s
%s
  const h = holder(x), fn = h ? h[0][h[1]] : x;
  const layers = chain(fn);
  return { ref, kind: kindOf(x), name: nameOf(x), patched_property: h ? (h[1] === 'type' ? 'memo.type' : 'render') : null,
    wrapped: layers.length > 0, depth: layers.length, layers,
    note: h ? undefined : 'a plain function export can only be patched on its module object; layers are those on the export itself' };
})()"""

_FIBER_JS = r"""(() => {
%s
  const sel = %s, up = %d, down = %d, mode = %s;
  let el;
  try { el = document.querySelector(sel); } catch (e) { return { error: 'bad selector: ' + e.message }; }
  if (!el) return { error: 'no element matches ' + sel + ' in ' + document.title };
  const start = fiberOf(el);
  if (!start) return { error: 'the element has no React fiber' };
  const describe = (f, extra) => {
    const t = f.type, kind = TAGS[f.tag] || 'tag' + f.tag, o = { kind, ...extra };
    if (f.tag === 5) {
      o.tag = t;
      const p = f.memoizedProps || {};
      if (p.id) o.id = p.id;
      if (typeof p.className === 'string' && p.className) o.class = short(p.className, 60);
      return o;
    }
    const comp = f.tag === 14 || f.tag === 15 ? f.elementType : t;
    const n = nameOf(comp);
    if (n) o.name = n;
    if (f.key != null) o.key = f.key;
    if (isBoundary(t)) o.error_boundary = true;
    if (f.tag === 15) o.simple_memo = true;
    const mp = f.memoizedProps, props = mp && typeof mp === 'object' && !Array.isArray(mp) ? Object.keys(mp).filter((k) => k !== 'children') : [];
    if (props.length) o.props = props.slice(0, 6).concat(props.length > 6 ? ['+' + (props.length - 6)] : []);
    const h = comp && holder(comp), fn = h ? h[0][h[1]] : (typeof t === 'function' ? t : null);
    if (fn) {
      const layers = chain(fn);
      if (layers.length) o.patched = layers.map((l) => l.ours || 'other');
      if (f.tag === 15 && f.type !== comp.type) o.stale_type = true;
      if (!n) o.src = short(srcOf(origOf(fn)).replace(/\s+/g, ' '), 70);
    }
    return o;
  };
  if (mode === 'patches') {
    const out = [];
    for (let f = start, i = 0; f && i <= up; f = f.return, i++) {
      if (f.tag === 5 || f.tag === 6 || f.tag === 3) continue;
      const comp = f.tag === 14 || f.tag === 15 ? f.elementType : f.type;
      const h = comp && holder(comp), fn = h ? h[0][h[1]] : (typeof f.type === 'function' ? f.type : null);
      const layers = fn ? chain(fn) : [];
      const stale = f.tag === 15 && comp && (f.type !== comp.type || (f.alternate && f.alternate.type !== comp.type));
      if (layers.length || stale) out.push({ level: i, kind: TAGS[f.tag], name: nameOf(comp), depth: layers.length, layers,
        fiber_current: !stale });
    }
    return { target: document.title, selector: sel, levels: up, patched: out };
  }
  const path = [];
  for (let f = start, i = 0; f && i <= up; f = f.return, i++) path.push(describe(f, { level: i }));
  const below = [];
  const walk = (f, d) => {
    for (let c = f.child; c && below.length < %d; c = c.sibling) {
      below.push(describe(c, { depth: d }));
      if (d < down) walk(c, d + 1);
    }
  };
  if (down > 0) walk(start, 1);
  return { target: document.title, selector: sel, up: path, ...(down > 0 ? { down: below } : {}),
    ...(below.length >= %d ? { truncated: true } : {}) };
})()"""


def line(o: dict[str, Any]) -> str:
    """One fiber as a line: `6 memo(simple) Name key=k [error boundary] patched=ours,other props=a,b src=...`."""
    at = o.get("level", o.get("depth"))
    if o["kind"] == "host":
        ident = "#" + o["id"] if o.get("id") else ""
        cls = f" .{o['class']}" if o.get("class") else ""
        return f"{at} <{o['tag']}{ident}>{cls}"
    parts = [str(at), o["kind"] + ("(simple)" if o.get("simple_memo") else "")]
    if o.get("name"):
        parts.append(o["name"])
    if o.get("key") is not None:
        parts.append(f"key={o['key']}")
    if o.get("error_boundary"):
        parts.append("[error boundary]")
    if o.get("patched"):
        parts.append("patched=" + ",".join(o["patched"]))
    if o.get("stale_type"):
        parts.append("[fiber type is not memo.type]")
    if o.get("props"):
        parts.append("props=" + ",".join(o["props"]))
    if o.get("src"):
        parts.append("src=" + o["src"])
    return " ".join(parts)


def _strings(value: Any, name: str) -> list[str]:
    items = [value] if isinstance(value, str) else value
    if not isinstance(items, list) or not items or not all(isinstance(s, str) and s for s in items):
        raise ValueError(f"{name} must be a non-empty string or list of strings")
    return items


def _int(value: Any, name: str, lo: int, hi: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not lo <= value <= hi:
        raise ValueError(f"{name} must be an integer {lo}-{hi}")
    return value


class ReactInspector:
    def __init__(self, evaluate: Evaluate | None = None) -> None:
        self._eval = evaluate or (lambda target, js: cdp.evaluate_in(target, js))

    async def _run(self, target: str | None, js: str) -> dict[str, Any]:
        result = await self._eval(target, js)
        if not isinstance(result, dict):
            raise cdp.CdpError(f"{target or 'SharedJSContext'} returned no result")
        if "error" in result:
            raise ValueError(result["error"])
        return result

    async def find(self, grep: Any, limit: int = 10) -> dict[str, Any]:
        needles = _strings(grep, "grep")
        js = _FIND_JS % (_HELPERS, json.dumps(needles), _int(limit, "limit", 1, MAX_FIND))
        return await self._run(None, js)

    async def tree(self, selector: str, target: str | None = None, depth: int = 10, down: int = 0) -> dict[str, Any]:
        js = _FIBER_JS % (_HELPERS, json.dumps(selector), _int(depth, "depth", 0, MAX_UP), _int(down, "down", 0, MAX_DOWN),
                          json.dumps("tree"), MAX_DOWN_NODES, MAX_DOWN_NODES)
        result = await self._run(target or QUERY_TARGET, js)
        result["up"] = [line(o) for o in result["up"]]
        if "down" in result:
            result["down"] = [line(o) for o in result["down"]]
        return result

    async def patches(self, ref: str | None = None, selector: str | None = None, target: str | None = None,
                      depth: int = 10) -> dict[str, Any]:
        if (ref is None) == (selector is None):
            raise ValueError("patches takes ref (from find) or selector")
        if ref is not None:
            return await self._run(None, _PATCHES_REF_JS % (_HELPERS, _RESOLVE_JS % json.dumps(ref)))
        js = _FIBER_JS % (_HELPERS, json.dumps(selector), _int(depth, "depth", 0, MAX_UP), 0, json.dumps("patches"),
                          MAX_DOWN_NODES, MAX_DOWN_NODES)
        return await self._run(target or QUERY_TARGET, js)
