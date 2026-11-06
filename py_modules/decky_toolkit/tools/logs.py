"""logs_read and logs_wait: one pair of tools over every log the device keeps."""
import asyncio
import os
import re
import time
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any

from ..games import files as games
from ..loader import logs
from ..steam.console import DEFAULT_LEVEL, DEFAULT_TARGETS, LEVELS
from . import ToolRegistry
from .plugins import resolve_plugin
from .system import run, tail

if TYPE_CHECKING:
    from ..steam.console import ConsoleCollector

SOURCES = ("loader", "plugin", "steam_console", "proton")
# Arguments beyond the shared ones (lines, grep, match) that each source takes.
SOURCE_ARGS = {
    "loader": {"since", "until"},
    "plugin": {"plugin", "run", "file"},
    "steam_console": {"target", "level", "since"},
    "proton": {"appid"},
}
WAIT_SOURCES = ("loader", "plugin", "steam_console")


def _regex(pattern: str, what: str = "match") -> re.Pattern[str]:
    try:
        return re.compile(pattern, re.IGNORECASE)
    except re.error as e:
        raise ValueError(f"{what} is not a valid regex: {e}") from None


def _filter(lines: list[str], grep: str | None, match: str | None) -> list[str]:
    if grep:
        needle = grep.lower()
        lines = [l for l in lines if needle in l.lower()]
    if match:
        rx = _regex(match)
        lines = [l for l in lines if rx.search(l)]
    return lines


def _check_source(source: str, given: dict[str, Any], allowed: dict[str, set[str]]) -> None:
    if source not in allowed:
        raise ValueError(f"source must be one of {', '.join(allowed)}")
    extra = sorted(k for k, v in given.items() if v is not None and k not in allowed[source])
    if extra:
        takes = ", ".join(sorted(allowed[source])) or "nothing else"
        raise ValueError(f"source {source!r} does not take {', '.join(extra)} (it takes {takes})")


def register(reg: ToolRegistry, console: "ConsoleCollector | None" = None) -> None:
    def collector() -> "ConsoleCollector":
        if console is None:
            raise ValueError("console capture is not running in this server")
        return console

    @reg.add(
        "logs_read",
        "Read one of the device's logs. source:\n"
        "- loader: the Decky Loader journal (every plugin's stdout/stderr and the loader's own 'Loaded <name>', "
        "'stopped in 0.1s', 'Sending SIGKILL'); since/until take journalctl times ('-2min', '10 min ago', "
        "'2026-11-06 01:30:00', 'today').\n"
        "- plugin: a plugin's backend log; Decky starts a file per backend start, run 0 is the current one, 1 the "
        "previous run (where its _unload lines ended up); or name a file.\n"
        f"- steam_console: Steam UI console output captured in the background (console.* calls, uncaught exceptions, "
        f"browser log), target {', '.join(DEFAULT_TARGETS)} (default {DEFAULT_TARGETS[0]}, where Decky and plugin "
        "frontends run) or 'all', level a minimum (debug < log = info < warn < error; default info), since an entry "
        "id (pass the previous call's last_id) or an ISO time.\n"
        "- proton: one title's ~/steam-<appid>.log (PROTON_LOG=1) and the lines mentioning it in Steam's logs.\n"
        "Every source takes lines, grep (substring) and match (regex), both case-insensitive.",
        {"properties": {
            "source": {"type": "string", "enum": list(SOURCES)},
            "lines": {"type": "integer", "default": 200, "minimum": 1, "maximum": 5000},
            "grep": {"type": "string", "description": "Case-insensitive substring"},
            "match": {"type": "string", "description": "Case-insensitive regex, e.g. 'Loaded|SIGKILL|stopped in'"},
            "since": {"type": ["string", "integer"], "description": "loader: journalctl time; steam_console: entry id or ISO time"},
            "until": {"type": "string", "description": "loader: journalctl time"},
            "plugin": {"type": "string", "description": "plugin: directory or plugin.json name (plugin_list)"},
            "run": {"type": "integer", "minimum": 0, "description": "plugin: 0 newest, 1 previous, ..."},
            "file": {"type": "string", "description": "plugin: a log file name"},
            "target": {"type": "string", "description": "steam_console: tab title or 'all'"},
            "level": {"type": "string", "enum": list(LEVELS), "description": "steam_console: minimum level"},
            "appid": {"type": "integer", "description": "proton: Steam appid"},
        }, "required": ["source"]},
    )
    async def logs_read(source: str, lines: int = 200, grep: str | None = None, match: str | None = None,
                        since: Any = None, until: str | None = None, plugin: str | None = None, run: int | None = None,
                        file: str | None = None, target: str | None = None, level: str | None = None,
                        appid: int | None = None) -> dict[str, Any]:
        _check_source(source, {"since": since, "until": until, "plugin": plugin, "run": run, "file": file,
                               "target": target, "level": level, "appid": appid}, SOURCE_ARGS)
        lines = max(1, min(int(lines), 5000))
        if source == "loader":
            return await _loader(lines, grep, match, since, until)
        if source == "plugin":
            if not plugin:
                raise ValueError("source 'plugin' needs plugin")
            return _plugin(resolve_plugin(plugin)[0], lines, run or 0, file, grep, match)
        if source == "steam_console":
            out = collector().query(target, lines if not match else 4000, level or DEFAULT_LEVEL, since, grep)
            if match:
                rx = _regex(match)
                out["entries"] = [e for e in out["entries"] if rx.search(e.get("text", ""))][-lines:]
                out["count"] = len(out["entries"])
            return {"source": source, **out}
        if isinstance(appid, bool) or not isinstance(appid, int) or appid <= 0:
            raise ValueError("source 'proton' needs appid, a positive integer")
        out = await asyncio.to_thread(games.proton_log, appid, lines if not (grep or match) else 5000)
        if grep or match:
            log = out.get("proton_log", {})
            if "lines" in log:
                log["lines"] = _filter(log["lines"], grep, match)[-lines:]
            for f in out.get("steam_logs", []):
                f["lines"] = _filter(f["lines"], grep, match)[-lines:]
        return {"source": source, **out}

    @reg.add(
        "logs_wait",
        "Block until a log line matches a regex (case-insensitive) and return it; use it instead of polling after a "
        "reload, deploy or action. source loader (the journal), plugin (plugin's newest log) or steam_console "
        "(target, level as in logs_read). Calls run one after another, so set since_s to also accept lines from the "
        "last few seconds (e.g. after a reload you just triggered). Times out without error: check 'matched'.",
        {"properties": {
            "pattern": {"type": "string", "description": "Regex, e.g. '\\bLoaded My Plugin' (\\b: not 'Unloaded')"},
            "source": {"type": "string", "enum": list(WAIT_SOURCES), "default": "loader"},
            "plugin": {"type": "string", "description": "plugin: directory or plugin.json name (plugin_list)"},
            "target": {"type": "string", "description": "steam_console: tab title or 'all'"},
            "level": {"type": "string", "enum": list(LEVELS), "description": "steam_console: minimum level"},
            "timeout": {"type": "number", "default": 30, "minimum": 0.1, "maximum": 300},
            "count": {"type": "integer", "default": 1, "minimum": 1, "maximum": 100},
            "since_s": {"type": "number", "default": 0, "minimum": 0, "maximum": 3600},
        }, "required": ["pattern"]},
    )
    async def logs_wait(pattern: str, source: str = "loader", plugin: str | None = None, target: str | None = None,
                        level: str | None = None, timeout: float = 30, count: int = 1,
                        since_s: float = 0) -> dict[str, Any]:
        _check_source(source, {"plugin": plugin, "target": target, "level": level},
                      {"loader": set(), "plugin": {"plugin"}, "steam_console": {"target", "level"}})
        timeout = min(max(timeout, 0.1), 300)
        if source != "steam_console":
            if source == "plugin" and not plugin:
                raise ValueError("source 'plugin' needs plugin")
            dirname = resolve_plugin(plugin)[0] if plugin else None
            return {"source": source, **await logs.wait_for(source, dirname, pattern, timeout, count, since_s)}
        return {"source": source, **await _wait_console(collector(), pattern, target, level, timeout, count, since_s)}

    async def _loader(lines: int, grep: str | None, match: str | None, since: Any, until: str | None) -> dict[str, Any]:
        filtered = bool(grep or match)
        argv = ["journalctl", "-u", "plugin_loader", "--no-pager", "-o", "short-iso"]
        argv += [f"--since={since}"] if since else ["-n", str(lines if not filtered else max(lines * 10, 2000))]
        if until:
            argv.append(f"--until={until}")
        code, out = await run(*argv)
        if code != 0:
            raise ValueError(out.strip()) if (since or until) else RuntimeError(out)
        return {"source": "loader", "text": "\n".join(_filter(out.splitlines(), grep, match)[-lines:])}

    def _plugin(plugin: str, lines: int, run_index: int, file: str | None, grep: str | None,
                match: str | None) -> dict[str, Any]:
        paths = logs.log_files(plugin)
        files = [os.path.basename(p) for p in paths]
        log_dir = logs.plugin_log_dir(plugin)
        if not files:
            return {"source": "plugin", "log_dir": log_dir, "files": [], "text": ""}
        if file is not None:
            if file not in files:
                raise FileNotFoundError(f"{file} not in {files}")
            chosen = file
        else:
            if run_index < 0 or run_index >= len(files):
                raise ValueError(f"run must be 0-{len(files) - 1} ({len(files)} log files)")
            chosen = files[run_index]
        text = tail(os.path.join(log_dir, chosen), lines if not (grep or match) else 20000)
        if grep or match:
            text = "\n".join(_filter(text.splitlines(), grep, match)[-lines:])
        return {"source": "plugin", "log_dir": log_dir, "files": files[:20], "file": chosen, "text": text}


async def _wait_console(console: "ConsoleCollector", pattern: str, target: str | None, level: str | None,
                        timeout: float, count: int, since_s: float) -> dict[str, Any]:
    rx = _regex(pattern, "pattern")
    t0 = time.monotonic()
    matched: list[dict[str, Any]] = []

    async def scan() -> None:
        if since_s:
            since = datetime.fromtimestamp(time.time() - since_s, timezone.utc).isoformat()
            for e in console.query(target, 4000, level or DEFAULT_LEVEL, since)["entries"]:
                if rx.search(e.get("text", "")):
                    matched.append(e)
                    if len(matched) >= count:
                        return
        async for e in console.follow(target, 0, level or DEFAULT_LEVEL):
            if rx.search(e.get("text", "")):
                matched.append(e)
                if len(matched) >= count:
                    return

    try:
        await asyncio.wait_for(scan(), timeout)
        timed_out = False
    except asyncio.TimeoutError:
        timed_out = True
    return {"matched": not timed_out, "entries": matched, "waited_ms": round((time.monotonic() - t0) * 1000)}
