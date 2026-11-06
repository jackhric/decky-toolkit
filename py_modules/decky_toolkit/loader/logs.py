"""Loader journal and plugin log files, as one-shot tails or followed line streams."""
import asyncio
import os
from typing import AsyncIterator

from ..tools.system import clean_env, run, tail

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


def _journal_argv(n: int, follow: bool) -> list[str]:
    return ["journalctl", "-u", "plugin_loader", "--no-pager", "-o", "short-iso", "-n", str(n), *(["-f"] if follow else [])]


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


async def _follow_journal(n: int) -> AsyncIterator[str]:
    proc = await asyncio.create_subprocess_exec(*_journal_argv(n, follow=True), stdout=asyncio.subprocess.PIPE,
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
