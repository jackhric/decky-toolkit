"""logs_read and logs_wait: one pair of tools over every log the device keeps."""
import asyncio
from typing import TYPE_CHECKING, Any

from ..games import files as games
from ..loader import logs
from ..steam.console import DEFAULT_LEVEL, DEFAULT_TARGETS, LEVELS
from . import ToolRegistry
from ..loader.plugins import resolve_plugin

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


def _check_source(source: str, given: dict[str, Any], allowed: dict[str, set[str]]) -> None:
    if source not in allowed:
        raise ValueError(f"source must be one of {', '.join(allowed)}")
    extra = sorted(k for k, v in given.items() if v is not None and k not in allowed[source])
    if extra:
        takes = ", ".join(sorted(allowed[source])) or "nothing else"
        raise ValueError(f"source {source!r} does not take {', '.join(extra)} (it takes {takes})")


def register(reg: ToolRegistry, console: "ConsoleCollector") -> None:

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
        lines = max(1, min(int(lines), logs.MAX_TAIL))
        if source == "loader":
            return {"source": source, "text": "\n".join(await logs.read_journal(lines, grep, match, since, until))}
        if source == "plugin":
            if not plugin:
                raise ValueError("source 'plugin' needs plugin")
            out = logs.read_plugin(resolve_plugin(plugin)[0], lines, run or 0, file, grep, match)
            text = "\n".join(out.pop("lines"))
            return {"source": source, **out, "text": text}
        if source == "steam_console":
            out = console.query(target, lines if not match else 4000, level or DEFAULT_LEVEL, since, grep)
            if match:
                rx = logs.regex(match)
                out["entries"] = [e for e in out["entries"] if rx.search(e.get("text", ""))][-lines:]
                out["count"] = len(out["entries"])
            return {"source": source, **out}
        if isinstance(appid, bool) or not isinstance(appid, int) or appid <= 0:
            raise ValueError("source 'proton' needs appid, a positive integer")
        out = await asyncio.to_thread(games.proton_log, appid, lines if not (grep or match) else 5000)
        if grep or match:
            log = out.get("proton_log", {})
            if "lines" in log:
                log["lines"] = logs.filter_lines(log["lines"], grep, match)[-lines:]
            for f in out.get("steam_logs", []):
                f["lines"] = logs.filter_lines(f["lines"], grep, match)[-lines:]
        return {"source": source, **out}

    @reg.add(
        "logs_wait",
        "Block until a log line matches a regex (case-insensitive) and return it; use it instead of polling after a "
        "reload, deploy or action. source loader (the journal), plugin (plugin's newest log) or steam_console "
        "(target, level as in logs_read). Calls run one after another, so set since_s to also accept lines from the "
        "last few seconds (e.g. after a reload you just triggered). Returns {source, matched, matches (lines, or "
        "console entries), waited_ms}; times out without error: check 'matched'.",
        {"properties": {
            "pattern": {"type": "string", "description": "Regex, e.g. '\\bLoaded My Plugin' (\\b: not 'Unloaded')"},
            "source": {"type": "string", "enum": list(logs.WAIT_SOURCES), "default": "loader"},
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
        if source == "plugin" and not plugin:
            raise ValueError("source 'plugin' needs plugin")
        dirname = resolve_plugin(plugin)[0] if plugin else None
        return {"source": source, **await logs.wait_for(source, pattern, timeout, count, since_s, plugin=dirname,
                                                        console=console, target=target, level=level)}
