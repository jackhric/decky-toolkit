"""Every log the device keeps (the loader journal, plugin log files, the Steam UI console): reading with grep/match
filters, following, and waiting for a matching line. The /logs routes and the logs_* tools both call these."""
import asyncio
import os
import re
import time
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any, AsyncIterator, Callable, Iterable

from ..system import clean_env, run, tail
from .plugins import check_dir_name

if TYPE_CHECKING:
    from ..steam.console import ConsoleCollector

DEFAULT_TAIL = 100
MAX_TAIL = 5000
POLL_SECONDS = 0.25
SOURCES = ("loader", "plugin")
WAIT_SOURCES = ("loader", "plugin", "steam_console")
# How far back a filtered read looks for `lines` matches.
JOURNAL_SCAN = 2000
PLUGIN_SCAN = 20000


def plugin_log_dir(plugin: str) -> str:
    return os.path.join(os.environ.get("DECKY_HOME", ""), "logs", check_dir_name(plugin))


def newest_log(log_dir: str) -> str | None:
    try:
        paths = [e.path for e in os.scandir(log_dir) if e.is_file()]
    except FileNotFoundError:
        return None
    return max(paths, key=os.path.getmtime, default=None)


def log_files(plugin: str) -> list[str]:
    """A plugin's log files, newest first (Decky starts one per backend start)."""
    log_dir = plugin_log_dir(plugin)
    try:
        paths = [e.path for e in os.scandir(log_dir) if e.is_file()]
    except FileNotFoundError:
        raise FileNotFoundError(f"no log dir {log_dir}") from None
    return sorted(paths, key=os.path.getmtime, reverse=True)


def regex(pattern: str, what: str = "match") -> re.Pattern[str]:
    try:
        return re.compile(pattern, re.IGNORECASE)
    except re.error as e:
        raise ValueError(f"{what} is not a valid regex: {e}") from None


def filter_lines(lines: Iterable[str], grep: str | None = None, match: str | None = None) -> list[str]:
    """Lines containing `grep` and matching the regex `match`, both case-insensitive."""
    rx = regex(match) if match else None
    needle = grep.lower() if grep else None
    return [l for l in lines if (needle is None or needle in l.lower()) and (rx is None or rx.search(l))]


def journal_argv(lines: int, since: str | None = None, until: str | None = None, follow: bool = False) -> list[str]:
    window = [f"--since={since}"] if since else ["-n", str(lines)]
    return ["journalctl", "-u", "plugin_loader", "--no-pager", "-o", "short-iso", *window,
            *([f"--until={until}"] if until else []), *(["-f"] if follow else [])]


async def read_journal(lines: int, grep: str | None = None, match: str | None = None, since: str | None = None,
                       until: str | None = None) -> list[str]:
    filtered = bool(grep or match)
    code, out = await run(*journal_argv(max(lines * 10, JOURNAL_SCAN) if filtered else lines, since, until))
    if code != 0:
        # With since/until the likely cause is a time journalctl does not understand.
        raise ValueError(out.strip()) if (since or until) else RuntimeError(out.strip())
    return filter_lines(out.splitlines(), grep, match)[-lines:] if lines > 0 else []


def read_plugin(plugin: str, lines: int, run_index: int = 0, file: str | None = None, grep: str | None = None,
                match: str | None = None) -> dict[str, Any]:
    """One run's log of a plugin (by directory): {log_dir, files (newest first, at most 20), file, lines}."""
    files = [os.path.basename(p) for p in log_files(plugin)]
    log_dir = plugin_log_dir(plugin)
    if not files:
        return {"log_dir": log_dir, "files": [], "file": None, "lines": []}
    if file is not None:
        if file not in files:
            raise FileNotFoundError(f"{file} not in {files}")
    elif not 0 <= run_index < len(files):
        raise ValueError(f"run must be 0-{len(files) - 1} ({len(files)} log files)")
    chosen = file if file is not None else files[run_index]
    filtered = bool(grep or match)
    text = tail(os.path.join(log_dir, chosen), PLUGIN_SCAN if filtered else lines) if lines > 0 else ""
    return {"log_dir": log_dir, "files": files[:20], "file": chosen,
            "lines": filter_lines(text.splitlines(), grep, match)[-lines:] if lines > 0 else []}


async def tail_lines(source: str, plugin: str | None, n: int) -> list[str]:
    if source == "loader":
        return await read_journal(n)
    return read_plugin(plugin or "", n)["lines"]


async def follow(source: str, plugin: str | None, n: int) -> AsyncIterator[str]:
    if source == "loader":
        async for line in _follow_journal(n):
            yield line
    else:
        async for line in _follow_plugin(plugin_log_dir(plugin or ""), n):
            yield line


async def _follow_journal(n: int, since: str | None = None) -> AsyncIterator[str]:
    proc = await asyncio.create_subprocess_exec(*journal_argv(n, since, follow=True), stdout=asyncio.subprocess.PIPE,
                                                stderr=asyncio.subprocess.STDOUT, env=clean_env())
    assert proc.stdout is not None
    try:
        while line := await proc.stdout.readline():
            yield line.decode(errors="replace").rstrip("\r\n")
    finally:
        if proc.returncode is None:
            proc.kill()
            await proc.wait()


async def _follow_plugin(log_dir: str, n: int) -> AsyncIterator[str]:
    path = newest_log(log_dir)
    if path and n > 0:
        for line in tail(path, n).splitlines():
            yield line
    offset = os.path.getsize(path) if path else 0
    partial = b""
    while True:
        await asyncio.sleep(POLL_SECONDS)
        newest = newest_log(log_dir)
        if newest != path and newest is not None:
            # Decky starts a new log file each time the plugin starts; read the rest of the old one first.
            if path:
                async for line in _drain(path, offset, partial):
                    yield line
            path, offset, partial = newest, 0, b""
        if path is None:
            continue
        try:
            with open(path, "rb") as f:
                f.seek(offset)
                data = f.read()
        except FileNotFoundError:
            path, offset, partial = None, 0, b""
            continue
        offset += len(data)
        *lines, partial = (partial + data).split(b"\n")
        for line in lines:
            yield line.decode(errors="replace").rstrip("\r")


async def _drain(path: str, offset: int, partial: bytes) -> AsyncIterator[str]:
    try:
        with open(path, "rb") as f:
            f.seek(offset)
            data = partial + f.read()
    except FileNotFoundError:
        data = partial
    for line in data.split(b"\n"):
        if line:
            yield line.decode(errors="replace").rstrip("\r")


_STAMP = re.compile(r"^\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)")


def _recent(lines: list[str], since_s: float) -> list[str]:
    """Plugin log lines written in the last `since_s` seconds (continuation lines follow their stamped line)."""
    cutoff, out, keep = time.time() - since_s, [], False
    for line in lines:
        m = _STAMP.match(line)
        if m:
            keep = datetime.strptime(m.group(1), "%Y-%m-%d %H:%M:%S").timestamp() >= cutoff - 1
        if keep:
            out.append(line)
    return out


async def _first_matches(recent: Iterable[Any], live: AsyncIterator[Any], rx: re.Pattern[str], count: int,
                         timeout: float, text: Callable[[Any], str]) -> dict[str, Any]:
    t0 = time.monotonic()
    matches: list[Any] = []

    async def scan() -> None:
        for item in recent:
            if rx.search(text(item)):
                matches.append(item)
                if len(matches) >= count:
                    return
        async for item in live:
            if rx.search(text(item)):
                matches.append(item)
                if len(matches) >= count:
                    return

    try:
        await asyncio.wait_for(scan(), timeout)
        matched = True
    except asyncio.TimeoutError:
        matched = False
    finally:
        await live.aclose()
    return {"matched": matched, "matches": matches, "waited_ms": round((time.monotonic() - t0) * 1000)}


async def wait_for(source: str, pattern: str, timeout: float, count: int = 1, since_s: float = 0, *,
                   plugin: str | None = None, console: "ConsoleCollector | None" = None, target: str | None = None,
                   level: str | None = None) -> dict[str, Any]:
    """Follow a log until `count` lines match `pattern` (regex, case-insensitive) or `timeout` seconds pass; with
    `since_s`, lines from that many seconds back count too. {matched, matches, waited_ms}: matches are log lines, or
    console entries for steam_console."""
    if source not in WAIT_SOURCES:
        raise ValueError(f"source must be one of {', '.join(WAIT_SOURCES)}")
    rx = regex(pattern, "pattern")
    if source == "steam_console":
        assert console is not None
        from ..steam.console import DEFAULT_LEVEL
        level = level or DEFAULT_LEVEL
        recent = console.query(target, 4000, level, datetime.fromtimestamp(time.time() - since_s, timezone.utc)
                               .isoformat())["entries"] if since_s else []
        return await _first_matches(recent, console.follow(target, 0, level), rx, count, timeout,
                                    lambda e: e.get("text", ""))
    if source == "loader":
        return await _first_matches([], _follow_journal(0, since=f"-{int(since_s)}s" if since_s else "now"), rx,
                                    count, timeout, str)
    log_dir = plugin_log_dir(plugin or "")
    path = newest_log(log_dir) if since_s else None
    recent = _recent(tail(path, 2000).splitlines(), since_s) if path else []
    return await _first_matches(recent, _follow_plugin(log_dir, 0), rx, count, timeout, str)
