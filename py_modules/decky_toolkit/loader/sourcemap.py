"""Maps `dist/*.js` positions in a plugin's error stack to its sources through the installed `.map` file
(the device-side twin of packages/client/src/sourcemap.ts)."""
import json
import os
import re
from typing import Callable
from urllib.parse import unquote

_B64 = {c: i for i, c in enumerate("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/")}
_FRAME = re.compile(r"\(?https?://127\.0\.0\.1:1337/plugins/([^/\s()]+)/dist/([^\s():?]+)(?:\?[^\s():]*)?:(\d+):(\d+)\)?")


def _vlq(text: str) -> list[int]:
    out, value, shift = [], 0, 0
    for c in text:
        d = _B64[c]
        value += (d & 31) << shift
        if d & 32:
            shift += 5
        else:
            out.append(-(value >> 1) if value & 1 else value >> 1)
            value = shift = 0
    return out


class SourceMap:
    def __init__(self, data: dict):
        self.sources = [(data.get("sourceRoot") or "") + s for s in data.get("sources") or []]
        self.lines: list[list[tuple[int, int, int, int]]] = []  # (column, source, line, source column), 0-based
        source = line = col = 0
        for text in (data.get("mappings") or "").split(";"):
            gen, segs = 0, []
            for raw in filter(None, text.split(",")):
                v = _vlq(raw)
                gen += v[0]
                if len(v) >= 4:
                    source, line, col = source + v[1], line + v[2], col + v[3]
                    segs.append((gen, source, line, col))
            self.lines.append(segs)

    def lookup(self, line: int, column: int) -> tuple[str, int, int] | None:
        """1-based line and column, as in a V8 stack frame."""
        segs = self.lines[line - 1] if 0 < line <= len(self.lines) else None
        if not segs:
            return None
        best = segs[0]
        for s in segs:
            if s[0] > column - 1:
                break
            best = s
        source = self.sources[best[1]] if best[1] < len(self.sources) else "?"
        return source, best[2] + 1, best[3] + 1


def short_source(source: str) -> str:
    s = re.sub(r"^decky://decky/plugin/[^/]+/", "", unquote(source))
    i = s.rfind("/src/")
    return s[i + 1:] if i >= 0 else re.sub(r"^(\.\./)+", "", s)


_cache: dict[str, tuple[float, SourceMap]] = {}


def load(path: str) -> SourceMap | None:
    try:
        mtime = os.stat(path).st_mtime
        hit = _cache.get(path)
        if hit and hit[0] == mtime:
            return hit[1]
        with open(path) as f:
            smap = SourceMap(json.load(f))
    except (OSError, ValueError):
        return None
    _cache[path] = (mtime, smap)
    return smap


def map_stack(text: str, dist_dir: Callable[[str], str | None]) -> str:
    """Rewrites bundle positions to `src/…:L:C`; `dist_dir` turns a plugin name (from the URL) into its dist directory."""
    def sub(m: re.Match[str]) -> str:
        whole = m.group(0)
        d = dist_dir(unquote(m.group(1)))
        smap = load(os.path.join(d, m.group(2) + ".map")) if d else None
        hit = smap.lookup(int(m.group(3)), int(m.group(4))) if smap else None
        if not hit:
            return whole
        pos = f"{short_source(hit[0])}:{hit[1]}:{hit[2]}"
        return f"({pos})" if whole.startswith("(") else pos
    return _FRAME.sub(sub, text)
