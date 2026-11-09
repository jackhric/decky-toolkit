"""Every log the device keeps (the loader journal, plugin log files, the Steam UI console): reading with grep/match
filters, following, and waiting for a matching line. The /logs routes and the logs_* tools both call these.

A read also returns a cursor (the journal's own cursor, or `<file>@<byte offset>` for plugin logs); passing it back
as `since` returns only what was written after it."""
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
    from ..steam.ui_trace import UiTrace

DEFAULT_TAIL = 100
MAX_TAIL = 5000
POLL_SECONDS = 0.25
SOURCES = ("loader", "plugin")
WAIT_SOURCES = ("loader", "plugin", "steam_console", "ui")
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


_CURSOR_LINE = "-- cursor: "


def is_journal_cursor(since: Any) -> bool:
    return isinstance(since, str) and since.startswith("s=")


def journal_argv(lines: int, since: str | None = None, until: str | None = None, follow: bool = False,
                 cursor: bool = False) -> list[str]:
    if is_journal_cursor(since):
        window = [f"--after-cursor={since}"]
    else:
        window = [f"--since={since}"] if since else ["-n", str(lines)]
    return ["journalctl", "-u", "plugin_loader", "--no-pager", "-o", "short-iso", *window,
            *([f"--until={until}"] if until else []), *(["--show-cursor"] if cursor else []),
            *(["-f"] if follow else [])]


async def read_journal(lines: int, grep: str | None = None, match: str | None = None, since: str | None = None,
                       until: str | None = None) -> tuple[list[str], str | None]:
    """The journal's last `lines` (matching) lines and the cursor after the newest one read."""
    filtered = bool(grep or match)
    # A mark (lines 0) still reads one entry: journalctl prints no cursor for an empty read.
    n = max(lines * 10, JOURNAL_SCAN) if filtered else max(lines, 1)
    code, out = await run(*journal_argv(n, since, until, cursor=True))
    if code != 0:
        # With since/until the likely cause is a time or cursor journalctl does not understand.
        raise ValueError(out.strip()) if (since or until) else RuntimeError(out.strip())
    rows = [r for r in out.splitlines() if r != "-- No entries --"]
    cursor = since if is_journal_cursor(since) else None
    if rows and rows[-1].startswith(_CURSOR_LINE):
        cursor = rows.pop()[len(_CURSOR_LINE):].strip()
    return (filter_lines(rows, grep, match)[-lines:] if lines > 0 else []), cursor


def parse_plugin_cursor(since: Any, files: list[str]) -> tuple[str, int]:
    file, sep, offset = str(since).rpartition("@")
    if not sep or not offset.isdigit():
        raise ValueError(f"since {since!r} is not a plugin log cursor (pass the cursor a previous read returned)")
    if file not in files:
        raise ValueError(f"since: log file {file} is gone (Decky keeps the newest runs only); read without since")
    return file, int(offset)


def _read_from(path: str, offset: int) -> tuple[list[str], int]:
    """Whole lines after `offset` and the offset after the last of them (a line still being written waits)."""
    with open(path, "rb") as f:
        f.seek(offset)
        data = f.read()
    end = data.rfind(b"\n") + 1
    return data[:end].decode(errors="replace").splitlines(), offset + end


def read_plugin(plugin: str, lines: int, run_index: int = 0, file: str | None = None, grep: str | None = None,
                match: str | None = None, since: Any = None) -> dict[str, Any]:
    """One run's log of a plugin (by directory): {log_dir, files (newest first, at most 20), file, lines, cursor}.
    With `since` (a cursor) the lines written after it, across backend restarts."""
    files = [os.path.basename(p) for p in log_files(plugin)]
    log_dir = plugin_log_dir(plugin)
    if not files:
        return {"log_dir": log_dir, "files": [], "file": None, "lines": [], "cursor": None}
    cursor = f"{files[0]}@{os.path.getsize(os.path.join(log_dir, files[0]))}"
    if since is not None and since != "":
        start, offset = parse_plugin_cursor(since, files)
        # Files are newest first; a backend restart since the cursor started new ones.
        newer = files[:files.index(start)]
        rows, end = _read_from(os.path.join(log_dir, start), offset)
        for name in reversed(newer):
            more, end = _read_from(os.path.join(log_dir, name), 0)
            rows += more
        cursor = f"{files[0]}@{end}"
        return {"log_dir": log_dir, "files": files[:20], "file": files[0], "cursor": cursor,
                "lines": filter_lines(rows, grep, match)[-lines:] if lines > 0 else []}
    if file is not None:
        if file not in files:
            raise FileNotFoundError(f"{file} not in {files}")
    elif not 0 <= run_index < len(files):
        raise ValueError(f"run must be 0-{len(files) - 1} ({len(files)} log files)")
    chosen = file if file is not None else files[run_index]
    filtered = bool(grep or match)
    text = tail(os.path.join(log_dir, chosen), PLUGIN_SCAN if filtered else lines) if lines > 0 else ""
    return {"log_dir": log_dir, "files": files[:20], "file": chosen, "cursor": cursor,
            "lines": filter_lines(text.splitlines(), grep, match)[-lines:] if lines > 0 else []}


async def tail_lines(source: str, plugin: str | None, n: int) -> list[str]:
    if source == "loader":
        return (await read_journal(n))[0]
    return read_plugin(plugin or "", n)["lines"]


async def follow(source: str, plugin: str | None, n: int) -> AsyncIterator[str]:
    if source == "loader":
        async for line in _follow_journal(n):
            yield line
    else:
        async for line in _follow_plugin(plugin_log_dir(plugin or ""), n):
            yield line


async def _follow_journal(n: int, since: str | None = None) -> AsyncIterator[str]:
    """`since` is a journalctl time or a cursor."""
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


async def _follow_plugin(log_dir: str, n: int, start: tuple[str, int] | None = None) -> AsyncIterator[str]:
    """New lines of the newest log; with `start` (file name, offset) from there on instead of from the end."""
    path = newest_log(log_dir)
    if start:
        path, offset = os.path.join(log_dir, start[0]), start[1]
    else:
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
                   level: str | None = None, since: Any = None, ui: "UiTrace | None" = None) -> dict[str, Any]:
    """Follow a log until `count` lines match `pattern` (regex, case-insensitive) or `timeout` seconds pass. Lines
    written after the cursor `since`, or in the last `since_s` seconds, count too. {matched, matches, waited_ms}:
    matches are log lines, or entries for steam_console and ui."""
    if source not in WAIT_SOURCES:
        raise ValueError(f"source must be one of {', '.join(WAIT_SOURCES)}")
    if since not in (None, "") and since_s:
        raise ValueError("give since (a cursor) or since_s, not both")
    rx = regex(pattern, "pattern")
    if source == "ui":
        assert ui is not None
        after = ui.parse_cursor(since if since not in (None, "") else time.time() * 1000 - since_s * 1000)
        return await _first_matches([], ui.follow(after), rx, count, timeout, lambda e: e.get("text", ""))
    if source == "steam_console":
        assert console is not None
        from ..steam.console import DEFAULT_LEVEL
        level = level or DEFAULT_LEVEL
        if since not in (None, ""):
            recent = console.query(target, 4000, level, since)["entries"]
        elif since_s:
            recent = console.query(target, 4000, level, datetime.fromtimestamp(time.time() - since_s, timezone.utc)
                                   .isoformat())["entries"]
        else:
            recent = []
        return await _first_matches(recent, console.follow(target, 0, level), rx, count, timeout,
                                    lambda e: e.get("text", ""))
    if source == "loader":
        if since not in (None, "") and not is_journal_cursor(since):
            raise ValueError(f"since {since!r} is not a loader cursor (pass the cursor logs_read returned)")
        start = since if since not in (None, "") else (f"-{int(since_s)}s" if since_s else "now")
        return await _first_matches([], _follow_journal(0, since=start), rx, count, timeout, str)
    log_dir = plugin_log_dir(plugin or "")
    if since not in (None, ""):
        files = [os.path.basename(p) for p in log_files(plugin or "")]
        return await _first_matches([], _follow_plugin(log_dir, 0, parse_plugin_cursor(since, files)), rx, count,
                                    timeout, str)
    path = newest_log(log_dir) if since_s else None
    recent = _recent(tail(path, 2000).splitlines(), since_s) if path else []
    return await _first_matches(recent, _follow_plugin(log_dir, 0), rx, count, timeout, str)
