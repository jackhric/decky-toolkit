"""Introspection of our own backend: thread and asyncio task stacks, and a watchdog for a blocked event loop.

A tool runs on the event loop, so it cannot report on a loop that is stuck; the watchdog thread can. It logs the
stack of every thread once the loop has not answered for `threshold` seconds (the loader's 5 s SIGKILL on unload
leaves no other trace). SIGUSR1 dumps the same through faulthandler, which works even if Python code cannot run.
"""
import asyncio
import faulthandler
import logging
import signal
import sys
import threading
import time
import traceback
from typing import Any, TextIO

STACK_LIMIT = 25


def _frames(frame: Any, limit: int = STACK_LIMIT) -> list[str]:
    return [f"{fs.filename}:{fs.lineno} in {fs.name}" + (f": {fs.line}" if fs.line else "")
            for fs in traceback.extract_stack(frame, limit=limit)]


def thread_stacks() -> list[dict[str, Any]]:
    names = {t.ident: t for t in threading.enumerate()}
    out = []
    for ident, frame in sys._current_frames().items():
        t = names.get(ident)
        out.append({"thread": t.name if t else str(ident), "daemon": bool(t and t.daemon), "stack": _frames(frame)})
    return out


def task_stacks(limit: int = STACK_LIMIT) -> list[dict[str, Any]]:
    out = []
    for task in asyncio.all_tasks():
        frames = task.get_stack(limit=limit)
        out.append({
            "name": task.get_name(),
            "coro": getattr(task.get_coro(), "__qualname__", repr(task.get_coro())),
            "stack": [f"{f.f_code.co_filename}:{f.f_lineno} in {f.f_code.co_name}" for f in frames],
        })
    return sorted(out, key=lambda t: t["coro"])


class LoopWatchdog:
    """Pings the loop from a thread; a ping left unanswered for `threshold` seconds logs every thread's stack."""

    def __init__(self, loop: asyncio.AbstractEventLoop, log: logging.Logger, threshold: float = 2.0,
                 interval: float = 0.5):
        self.loop, self.log, self.threshold, self.interval = loop, log, threshold, interval
        self.max_lag = 0.0
        self.stalls: list[dict[str, Any]] = []
        self._answered = time.monotonic()
        self._loop_thread = threading.get_ident()  # constructed on the loop's thread
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="loop-watchdog", daemon=True)

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _pong(self, sent: float) -> None:
        now = time.monotonic()
        self.max_lag = max(self.max_lag, now - sent)
        self._answered = now

    def _run(self) -> None:
        stalled_since: float | None = None
        while not self._stop.wait(self.interval):
            sent = time.monotonic()
            try:
                self.loop.call_soon_threadsafe(self._pong, sent)
            except RuntimeError:
                return  # loop closed
            silent = sent - self._answered
            if stalled_since is None and silent >= self.threshold:
                stalled_since = self._answered
                frame = sys._current_frames().get(self._loop_thread)
                stack = _frames(frame) if frame else []
                self.stalls.append({"at": time.time() - silent, "stack": stack, "lasted_s": None})
                del self.stalls[:-10]
                self.log.warning("event loop blocked for %.1f s; loop thread stack:\n  %s", silent, "\n  ".join(stack))
            elif stalled_since is not None and silent < self.interval * 2:
                lasted = self._answered - stalled_since
                self.stalls[-1]["lasted_s"] = round(lasted, 2)
                self.log.warning("event loop answered again after %.1f s", lasted)
                stalled_since = None

    def stats(self) -> dict[str, Any]:
        return {"threshold_s": self.threshold, "max_lag_ms": round(self.max_lag * 1000, 1), "stalls": self.stalls}


_watchdog: LoopWatchdog | None = None
_dump_file: TextIO | None = None


def install(log: logging.Logger, dump_path: str | None = None) -> LoopWatchdog:
    """Start the loop watchdog (once) and route SIGUSR1 to a faulthandler dump of every thread."""
    global _watchdog, _dump_file
    if _watchdog is None:
        _watchdog = LoopWatchdog(asyncio.get_running_loop(), log)
        _watchdog.start()
        if dump_path:
            try:
                _dump_file = open(dump_path, "a")
                faulthandler.register(signal.SIGUSR1, file=_dump_file, all_threads=True)
            except (OSError, ValueError, AttributeError) as e:
                log.info("SIGUSR1 stack dumps unavailable: %s", e)
    return _watchdog


def snapshot() -> dict[str, Any]:
    return {
        "threads": thread_stacks(),
        "tasks": task_stacks(),
        "loop": _watchdog.stats() if _watchdog else None,
    }
