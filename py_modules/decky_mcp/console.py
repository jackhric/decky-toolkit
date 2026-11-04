"""Steam UI console capture: one long-lived DevTools session per watched CEF target, buffering
Runtime.consoleAPICalled, Runtime.exceptionThrown and Log.entryAdded."""
import asyncio
import collections
import datetime
import itertools
import json
import logging
import re
import time
from typing import Any, AsyncIterator

import aiohttp

from . import cdp

DEFAULT_TARGETS = ("SharedJSContext", "Steam Big Picture Mode")
BUFFER_SIZE = 2000
MAX_TEXT = 8000
LEVELS = {"debug": 0, "log": 1, "info": 1, "warn": 2, "error": 3}
DEFAULT_LEVEL = "info"
BACKOFF_SECONDS = (1, 2, 5, 10)
STABLE_SECONDS = 30
# Every object argument a console call passes to us gets a remote object id in the "console" group of
# our session, which keeps it alive in the Steam UI's heap until released.
RELEASE_SECONDS = 30
_CONSOLE_LEVELS = {"warning": "warn", "error": "error", "assert": "error", "debug": "debug", "info": "info"}
_LOG_LEVELS = {"verbose": "debug", "info": "info", "warning": "warn", "error": "error"}
_FORMAT = re.compile(r"%[sdifoOc%]")


def _quote(s: str) -> str:
    return "'" + s.replace("'", "\\'") + "'"


def _render_preview(p: dict[str, Any], depth: int = 0) -> str:
    props = p.get("properties") or []
    if p.get("subtype") == "array":
        body = ", ".join(_render_prop(x, depth) for x in props)
        return f"[{body}{', …' if p.get('overflow') else ''}]"
    entries = p.get("entries")
    if entries is not None:
        items = []
        for e in entries:
            key = e.get("key")
            val = _render_preview(e["value"], depth + 1) if e.get("value") else ""
            items.append(f"{_render_preview(key, depth + 1)} => {val}" if key else val)
        return f"{p.get('description', '')} {{{', '.join(items)}{', …' if p.get('overflow') else ''}}}".strip()
    if p.get("type") != "object" or not props and p.get("description") not in (None, "Object"):
        return p.get("description") or ""
    body = ", ".join(f"{x.get('name')}: {_render_prop(x, depth)}" for x in props)
    prefix = "" if p.get("description") in (None, "Object") else p["description"] + " "
    return f"{prefix}{{{body}{', …' if p.get('overflow') else ''}}}"


def _render_prop(x: dict[str, Any], depth: int) -> str:
    if x.get("valuePreview") and depth < 2:
        return _render_preview(x["valuePreview"], depth + 1)
    if x.get("type") == "string":
        return _quote(x.get("value", ""))
    if x.get("type") == "accessor":
        return "(...)"
    return str(x.get("value", x.get("type")))


def render_remote_object(o: dict[str, Any], top: bool = True) -> str:
    """A Runtime.RemoteObject as console text: strings raw at top level, objects via their preview."""
    t, sub = o.get("type"), o.get("subtype")
    if "unserializableValue" in o:
        return str(o["unserializableValue"])
    if t == "undefined":
        return "undefined"
    if t == "string":
        v = str(o.get("value", ""))
        return v if top else _quote(v)
    if t in ("number", "boolean"):
        return json.dumps(o.get("value"))
    if t == "function":
        return (o.get("description") or "function").splitlines()[0][:200]
    if t == "object":
        if sub == "null":
            return "null"
        if sub in ("error", "regexp", "date", "node") or not o.get("preview"):
            if "value" in o:
                return json.dumps(o["value"], ensure_ascii=False, default=str)
            return o.get("description") or o.get("className") or "Object"
        return _render_preview(o["preview"])
    return o.get("description") or str(o.get("value", t))


def render_args(args: list[dict[str, Any]]) -> str:
    rest = list(args)
    parts: list[str] = []
    if rest and rest[0].get("type") == "string" and "%" in str(rest[0].get("value", "")):
        fmt = str(rest.pop(0)["value"])

        def sub(m: re.Match[str]) -> str:
            spec = m.group(0)
            if spec == "%%":
                return "%"
            if not rest:
                return spec
            arg = rest.pop(0)
            if spec == "%c":
                return ""
            if spec in ("%d", "%i") and arg.get("type") == "number":
                return str(int(arg.get("value") or 0))
            return render_remote_object(arg)

        parts.append(_FORMAT.sub(sub, fmt))
    parts += [render_remote_object(a) for a in rest]
    return " ".join(p for p in parts if p.strip() != "")


def _iso(ts: float) -> str:
    return datetime.datetime.fromtimestamp(ts).astimezone().isoformat(timespec="milliseconds")


def _top_frame(stack: dict[str, Any] | None) -> dict[str, Any] | None:
    frames = (stack or {}).get("callFrames") or []
    return frames[0] if frames else None


def parse_event(method: str, params: dict[str, Any]) -> dict[str, Any] | None:
    """Turn one CDP event into a buffer entry (without id/target), or None if it is not a console event."""
    url = line = column = None
    func = None
    if method == "Runtime.consoleAPICalled":
        kind = params.get("type", "log")
        level = _CONSOLE_LEVELS.get(kind, "log")
        text = render_args(params.get("args") or [])
        source = "console"
        frame = _top_frame(params.get("stackTrace"))
        ts = params.get("timestamp")
    elif method == "Runtime.exceptionThrown":
        d = params.get("exceptionDetails") or {}
        kind, level, source = "exception", "error", "exception"
        exc = d.get("exception") or {}
        detail = exc.get("description") if exc.get("type") == "object" else (render_remote_object(exc) if exc else "")
        text = " ".join(x for x in (d.get("text"), detail) if x)
        frame = _top_frame(d.get("stackTrace"))
        if d.get("url"):
            frame = {"url": d.get("url"), "lineNumber": d.get("lineNumber"), "columnNumber": d.get("columnNumber"),
                     "functionName": (frame or {}).get("functionName")}
        ts = params.get("timestamp")
    elif method == "Log.entryAdded":
        e = params.get("entry") or {}
        kind, source = e.get("source", "other"), "log"
        level = _LOG_LEVELS.get(e.get("level", ""), "info")
        text = e.get("text", "")
        frame = _top_frame(e.get("stackTrace")) or ({"url": e["url"], "lineNumber": e.get("lineNumber")} if e.get("url") else None)
        ts = e.get("timestamp")
    else:
        return None
    if frame:
        url = frame.get("url") or None
        if isinstance(frame.get("lineNumber"), int):
            line = frame["lineNumber"] + 1  # CDP numbers lines from 0
        if isinstance(frame.get("columnNumber"), int):
            column = frame["columnNumber"] + 1
        func = frame.get("functionName") or None
    stamp = ts / 1000 if isinstance(ts, (int, float)) and ts > 0 else time.time()
    if len(text) > MAX_TEXT:
        text = text[:MAX_TEXT] + f"… ({len(text)} chars)"
    entry = {"ts": stamp, "time": _iso(stamp), "source": source, "type": kind, "level": level, "text": text.strip()}
    if url:
        entry["url"] = url
        if line is not None:
            entry.update(line=line, column=column)
    if func:
        entry["function"] = func
    return entry


def parse_since(since: Any) -> tuple[str, float] | None:
    """`since` is an entry id (entries after it) or an ISO time (entries after it; naive = device local time)."""
    if since is None or since == "":
        return None
    if isinstance(since, bool):
        raise ValueError("since must be an entry id or an ISO time")
    if isinstance(since, (int, float)) or (isinstance(since, str) and since.strip().isdigit()):
        return ("id", float(since))
    if not isinstance(since, str):
        raise ValueError("since must be an entry id or an ISO time")
    try:
        dt = datetime.datetime.fromisoformat(since.strip().replace("Z", "+00:00"))
    except ValueError:
        raise ValueError(f"since {since!r} is neither an entry id nor an ISO time") from None
    return ("ts", dt.timestamp())


def check_level(level: str | None) -> str | None:
    if level is None or level == "":
        return None
    if level not in LEVELS:
        raise ValueError(f"level must be one of {', '.join(LEVELS)}")
    return level


class _Watch:
    def __init__(self, name: str, size: int):
        self.name = name
        self.buffer: collections.deque[dict[str, Any]] = collections.deque(maxlen=size)
        # Decky's WSRouter logs every backend call at debug level (a plugin polling twice a second
        # fills 2000 entries in ~8 minutes), so debug gets its own ring and cannot evict errors.
        self.debug: collections.deque[dict[str, Any]] = collections.deque(maxlen=size)
        self.connected = False
        self.target_url: str | None = None
        self.error: str | None = None
        self.connected_at: float | None = None
        self.high_ts = 0.0
        self.dropped = 0
        self.task: asyncio.Task[None] | None = None


class ConsoleCollector:
    def __init__(self, logger: logging.Logger | None = None, targets: tuple[str, ...] = DEFAULT_TARGETS,
                 size: int = BUFFER_SIZE):
        self.log = logger or logging.getLogger("decky_mcp.console")
        self._watches = {name: _Watch(name, size) for name in targets}
        self._ids = itertools.count(1)
        self._subs: set[tuple[str, asyncio.Queue[dict[str, Any]]]] = set()
        self._stopping = False

    @property
    def targets(self) -> list[str]:
        return list(self._watches)

    def start(self) -> None:
        self._stopping = False
        for w in self._watches.values():
            if w.task is None or w.task.done():
                w.task = asyncio.create_task(self._run(w), name=f"console:{w.name}")

    async def stop(self) -> None:
        self._stopping = True
        tasks = [w.task for w in self._watches.values() if w.task]
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        for w in self._watches.values():
            w.task = None
            w.connected = False

    # ---- buffer ----

    def _watch(self, target: str) -> _Watch:
        for name, w in self._watches.items():
            if name.lower() == target.lower():
                return w
        raise ValueError(f"target must be one of {', '.join(self._watches)} or 'all'")

    def _select(self, target: str | None) -> list[_Watch]:
        if target is None or target == "":
            target = DEFAULT_TARGETS[0]
        return list(self._watches.values()) if target == "all" else [self._watch(target)]

    def add(self, target: str, entry: dict[str, Any]) -> dict[str, Any]:
        w = self._watch(target)
        entry = {"id": next(self._ids), "target": w.name, **entry}
        ring = w.debug if entry["level"] == "debug" else w.buffer
        if len(ring) == ring.maxlen:
            w.dropped += 1
        ring.append(entry)
        w.high_ts = max(w.high_ts, entry["ts"])
        for name, q in list(self._subs):
            if name in (w.name, "all"):
                if q.full():
                    q.get_nowait()
                q.put_nowait(entry)
        return entry

    def handle_message(self, target: str, msg: dict[str, Any], cutoff: float = 0.0) -> dict[str, Any] | None:
        method = msg.get("method")
        if not method:
            return None
        entry = parse_event(method, msg.get("params") or {})
        if entry is None:
            return None
        # Runtime.enable replays the messages V8 still holds; after a reconnect to the same page those
        # are already buffered.
        if cutoff and method != "Log.entryAdded" and entry["ts"] <= cutoff:
            return None
        return self.add(target, entry)

    def query(self, target: str | None = None, lines: int = 200, level: str | None = DEFAULT_LEVEL,
              since: Any = None, grep: str | None = None) -> dict[str, Any]:
        watches = self._select(target)
        level = check_level(level)
        after = parse_since(since)
        lines = max(1, min(int(lines), BUFFER_SIZE * len(self._watches)))
        needle = grep.lower() if grep else None
        rings = [w.buffer for w in watches] + ([] if level and LEVELS[level] > LEVELS["debug"] else [w.debug for w in watches])
        rows = sorted((e for ring in rings for e in ring), key=lambda e: e["id"])
        out = [e for e in rows if self._matches(e, level, after, needle)][-lines:]
        return {
            "target": watches[0].name if len(watches) == 1 else "all",
            "status": [self._status(w) for w in watches],
            "last_id": max((ring[-1]["id"] for w in watches for ring in (w.buffer, w.debug) if ring), default=None),
            "count": len(out),
            "entries": [{k: v for k, v in e.items() if k != "ts"} for e in out],
        }

    @staticmethod
    def _matches(e: dict[str, Any], level: str | None, after: tuple[str, float] | None, needle: str | None) -> bool:
        if level and LEVELS[e["level"]] < LEVELS[level]:
            return False
        if after and (e["id"] if after[0] == "id" else e["ts"]) <= after[1]:
            return False
        if needle and needle not in e["text"].lower() and needle not in (e.get("url") or "").lower():
            return False
        return True

    def clear(self, target: str | None = None) -> dict[str, int]:
        watches = list(self._watches.values()) if target in (None, "", "all") else [self._watch(target)]
        cleared = {}
        for w in watches:
            cleared[w.name] = len(w.buffer) + len(w.debug)
            w.buffer.clear()
            w.debug.clear()
            w.dropped = 0
        return cleared

    def _status(self, w: _Watch) -> dict[str, Any]:
        return {"target": w.name, "connected": w.connected, "buffered": len(w.buffer), "buffered_debug": len(w.debug),
                "dropped": w.dropped,
                "connected_since": _iso(w.connected_at) if w.connected_at else None, "error": w.error}

    def status(self) -> list[dict[str, Any]]:
        return [self._status(w) for w in self._watches.values()]

    async def follow(self, target: str | None = None, tail: int = 100, level: str | None = DEFAULT_LEVEL) -> AsyncIterator[dict[str, Any]]:
        names = [w.name for w in self._select(target)]
        level = check_level(level)
        key = names[0] if len(names) == 1 else "all"
        q: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=1000)
        sub = (key, q)
        self._subs.add(sub)  # before the snapshot, so nothing falls between replay and live
        try:
            last = 0
            if tail > 0:
                for e in self.query(key, lines=tail, level=level)["entries"]:
                    last = e["id"]
                    yield e
            while True:
                e = await q.get()
                if e["id"] > last and self._matches(e, level, None, None):
                    yield {k: v for k, v in e.items() if k != "ts"}
        finally:
            self._subs.discard(sub)

    # ---- connection ----

    async def _find(self, name: str) -> dict[str, Any]:
        targets = await cdp.list_targets()
        names = cdp.SHARED_CTX_NAMES if name == "SharedJSContext" else (name,)
        for n in names:
            for t in targets:
                if t.get("title") == n and t.get("webSocketDebuggerUrl"):
                    return t
        raise cdp.CdpError(f"no CEF target titled {name!r}")

    async def _run(self, w: _Watch) -> None:
        failures = 0
        while not self._stopping:
            started = time.monotonic()
            try:
                target = await self._find(w.name)
                await self._session(w, target)
                w.error = None
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001 - Steam restarting is routine; keep retrying
                msg = f"{type(e).__name__}: {e}"
                if msg != w.error:
                    self.log.info("console: %s unavailable: %s", w.name, msg)
                w.error = msg
            if w.connected:
                self.log.info("console: detached from %s", w.name)
            w.connected, w.connected_at = False, None
            failures = 0 if time.monotonic() - started > STABLE_SECONDS else failures + 1
            await asyncio.sleep(BACKOFF_SECONDS[min(failures, len(BACKOFF_SECONDS)) - 1] if failures else BACKOFF_SECONDS[0])

    async def _session(self, w: _Watch, target: dict[str, Any]) -> None:
        cutoff = w.high_ts
        async with aiohttp.ClientSession() as session:
            async with session.ws_connect(target["webSocketDebuggerUrl"], max_msg_size=64 * 1024 * 1024,
                                          heartbeat=30) as ws:
                ids = itertools.count(1)
                await ws.send_json({"id": next(ids), "method": "Runtime.enable", "params": {}})
                await ws.send_json({"id": next(ids), "method": "Log.enable", "params": {}})
                w.connected, w.connected_at, w.target_url, w.error = True, time.time(), target.get("url"), None
                self.log.info("console: attached to %s", w.name)

                async def release() -> None:
                    while True:
                        await asyncio.sleep(RELEASE_SECONDS)
                        await ws.send_json({"id": next(ids), "method": "Runtime.releaseObjectGroup",
                                            "params": {"objectGroup": "console"}})

                releaser = asyncio.create_task(release())
                try:
                    async for msg in ws:
                        if msg.type != aiohttp.WSMsgType.TEXT:
                            continue
                        data = json.loads(msg.data)
                        if "error" in data and "id" in data:
                            self.log.warning("console: %s: %s", w.name, data["error"])
                        self.handle_message(w.name, data, cutoff)
                finally:
                    releaser.cancel()
                    await asyncio.gather(releaser, return_exceptions=True)
