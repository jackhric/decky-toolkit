"""Workarounds for Decky Loader bugs, applied inside our own plugin process only.

Each one should go once the loader version that fixes it is the oldest we support.
"""
import asyncio
import inspect
import logging
from typing import Any

_PATCHED = "_decky_toolkit_eof_patch"


def patch_socket_eof(log: logging.Logger, socket_cls: Any = None) -> bool:
    """Stop the loader's plugin socket reader from spinning once the loader closes the socket.

    decky-loader v3.3.1 (`localplatform/localsocket.py`, unchanged on main): on shutdown the loader
    closes our socket right after SIGTERM, `readuntil` then fails at EOF without suspending, and
    `_listen_for_method_call` loops on "" forever without yielding. That starves the event loop, so
    `_unload` stalls at its first real await until the 5 s SIGKILL, and an orphaned backend leaks a task
    per spin (observed: 6 GB). At EOF the wrapper waits instead, which yields to everything else.
    """
    try:
        if socket_cls is None:
            from decky_loader.localplatform.localsocket import UnixSocket as socket_cls
        original = getattr(socket_cls, "_read_single_line", None)
        if original is None or not inspect.iscoroutinefunction(original):
            log.info("loader socket reader not found; EOF workaround not applied")
            return False
        if getattr(original, _PATCHED, False):
            return True

        async def read_single_line(self, reader: asyncio.StreamReader) -> str:
            line = await original(self, reader)
            if not line and reader.at_eof():
                await asyncio.Event().wait()
            return line

        setattr(read_single_line, _PATCHED, True)
        socket_cls._read_single_line = read_single_line
        log.info("applied loader socket EOF workaround")
        return True
    except Exception as e:  # noqa: BLE001 - a workaround must never keep the plugin from starting
        log.warning("loader socket EOF workaround not applied: %s: %s", type(e).__name__, e)
        return False
