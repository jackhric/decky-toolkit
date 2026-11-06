"""Loader journal and plugin log files, as one-shot tails or followed line streams."""
import asyncio
import os
import re
import time
from datetime import datetime
from typing import AsyncIterator

from ..system import clean_env, run, tail

DEFAULT_TAIL = 100
MAX_TAIL = 5000
POLL_SECONDS = 0.25
SOURCES = ("loader", "plugin")


def plugin_log_dir(plugin: str) -> str:
    if not plugin or "/" in plugin or plugin.startswith("."):
        raise ValueError("plugin must be a bare plugin directory name")
    return os.path.join(os.environ.get("DECKY_HOME", ""), "logs", plugin)


def newest_log(log_dir: str) -> str | None:
    try:
        paths = [e.path for e in os.scandir(log_dir) if e.is_file()]
    except FileNotFoundError:
        return None
    return max(paths, key=os.path.getmtime, default=None)


def _journal_argv(n: int, follow: bool, since: str | None = None) -> list[str]:
    window = [f"--since={since}"] if since else ["-n", str(n)]
    return ["journalctl", "-u", "plugin_loader", "--no-pager", "-o", "short-iso", *window, *(["-f"] if follow else [])]


async def tail_lines(source: str, plugin: str | None, n: int) -> list[str]:
    if source == "loader":
        code, out = await run(*_journal_argv(n, follow=False))
        if code != 0:
            raise RuntimeError(out.strip())
        return out.splitlines()
    log_dir = plugin_log_dir(plugin or "")
    if not os.path.isdir(log_dir):
        raise FileNotFoundError(f"no log dir {log_dir}")
    path = newest_log(log_dir)
    return tail(path, n).splitlines() if path and n > 0 else []


async def follow(source: str, plugin: str | None, n: int) -> AsyncIterator[str]:
    if source == "loader":
        async for line in _follow_journal(n):
            yield line
    else:
        async for line in _follow_plugin(plugin_log_dir(plugin or ""), n):
            yield line


async def _follow_journal(n: int, since: str | None = None) -> AsyncIterator[str]:
    proc = await asyncio.create_subprocess_exec(*_journal_argv(n, follow=True, since=since), stdout=asyncio.subprocess.PIPE,
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


def log_files(plugin: str) -> list[str]:
    """A plugin's log files, newest first (Decky starts one per backend start)."""
    log_dir = plugin_log_dir(plugin)
    try:
        paths = [e.path for e in os.scandir(log_dir) if e.is_file()]
    except FileNotFoundError:
        raise FileNotFoundError(f"no log dir {log_dir}") from None
    return sorted(paths, key=os.path.getmtime, reverse=True)


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


async def wait_for(source: str, plugin: str | None, pattern: str, timeout: float, count: int = 1,
                   since_s: float = 0) -> dict:
    """Follow a log until `count` lines match `pattern` (regex, case-insensitive) or `timeout` seconds pass."""
    if source not in SOURCES:
        raise ValueError(f"source must be one of {', '.join(SOURCES)}")
    try:
        rx = re.compile(pattern, re.IGNORECASE)
    except re.error as e:
        raise ValueError(f"pattern is not a valid regex: {e}") from None
    t0 = time.monotonic()
    matched: list[str] = []

    async def scan() -> None:
        if source == "loader":
            lines = _follow_journal(0, since=f"-{int(since_s)}s" if since_s else "now")
        else:
            log_dir = plugin_log_dir(plugin or "")
            if since_s:
                path = newest_log(log_dir)
                for line in _recent(tail(path, 2000).splitlines() if path else [], since_s):
                    if rx.search(line):
                        matched.append(line)
                        if len(matched) >= count:
                            return
            lines = _follow_plugin(log_dir, 0)
        async for line in lines:
            if rx.search(line):
                matched.append(line)
                if len(matched) >= count:
                    return

    try:
        await asyncio.wait_for(scan(), timeout)
        timed_out = False
    except asyncio.TimeoutError:
        timed_out = True
    return {"matched": not timed_out, "lines": matched, "waited_ms": round((time.monotonic() - t0) * 1000)}
