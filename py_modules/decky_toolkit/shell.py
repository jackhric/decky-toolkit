"""Shell commands on the device (device_run, POST /exec) for paired clients, as the desktop user or (on request) root.

A paired client can already run anything as root by installing a plugin, so this adds no access; it replaces ssh
for development. Every command is logged in full (the one place arguments are), with the user and caller.
"""
import asyncio
import logging
import os
import pwd
import signal
import tempfile
import time
from typing import Any

from .server.audit import request_origin
from .tools.system import clean_env

DEFAULT_TIMEOUT = 60
MAX_TIMEOUT = 600
DEFAULT_OUTPUT = 64 * 1024
MAX_OUTPUT = 1024 * 1024
LOGGED_CHARS = 300
BACKGROUND_GRACE = 1.0
DEFAULT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

log = logging.getLogger("decky_toolkit.shell")


def desktop_user() -> pwd.struct_passwd:
    """Decky's user (the one Steam runs as); the current user when not under the loader (tests)."""
    name = os.environ.get("DECKY_USER")
    try:
        return pwd.getpwnam(name) if name else pwd.getpwuid(os.getuid())
    except KeyError:
        return pwd.getpwuid(os.getuid())


def _env(user: pwd.struct_passwd, as_root: bool) -> dict[str, str]:
    base = clean_env()
    runtime = f"/run/user/{user.pw_uid}"
    env = {
        "PATH": base.get("PATH") or DEFAULT_PATH,
        "LANG": base.get("LANG", "C.UTF-8"),
        "TERM": "dumb",
        # The desktop session's: PipeWire, gamescope, D-Bus and X all live there, for root as well.
        "XDG_RUNTIME_DIR": runtime,
        "DBUS_SESSION_BUS_ADDRESS": f"unix:path={runtime}/bus",
        "DISPLAY": ":0",
    }
    if as_root:
        env.update(HOME="/root", USER="root", LOGNAME="root", SHELL="/bin/bash")
    else:
        env.update(HOME=user.pw_dir, USER=user.pw_name, LOGNAME=user.pw_name, SHELL=user.pw_shell or "/bin/bash")
    return env


class _Capped:
    """Reads a stream, keeping the first `cap` bytes; what it has survives cancelling the read."""

    def __init__(self, cap: int):
        self.cap, self.kept, self.total = cap, bytearray(), 0

    async def read(self, fd: int) -> None:
        """Reads `fd` (non-blocking) to EOF, then closes it; cancelling stops reading and closes it too."""
        loop = asyncio.get_running_loop()
        done = loop.create_future()

        def readable() -> None:
            try:
                while chunk := os.read(fd, 65536):
                    self.total += len(chunk)
                    if len(self.kept) < self.cap:
                        self.kept += chunk[: self.cap - len(self.kept)]
                if not done.done():
                    done.set_result(None)
            except BlockingIOError:
                pass
            except OSError as e:
                if not done.done():
                    done.set_exception(e)

        os.set_blocking(fd, False)
        loop.add_reader(fd, readable)
        try:
            await done
        finally:
            loop.remove_reader(fd)
            os.close(fd)


def _kill_group(proc: asyncio.subprocess.Process, sig: int) -> None:
    try:
        os.killpg(proc.pid, sig)
    except (ProcessLookupError, PermissionError):
        pass


async def run_command(command: str, cwd: str | None = None, timeout: float = DEFAULT_TIMEOUT, root: bool = False,
                      stdin: str | None = None, max_output: int = DEFAULT_OUTPUT,
                      logger: logging.Logger = log) -> dict[str, Any]:
    if not isinstance(command, str) or not command.strip():
        raise ValueError("command must be a non-empty string")
    timeout = min(max(float(timeout), 0.1), MAX_TIMEOUT)
    cap = min(max(int(max_output), 1024), MAX_OUTPUT)
    user = desktop_user()
    if root and os.geteuid() != 0:
        raise PermissionError("root: true needs the backend to run as root")
    as_root = root or user.pw_uid == 0
    switch = not as_root and os.geteuid() == 0
    workdir = cwd or ("/root" if as_root else user.pw_dir)
    if not os.path.isdir(workdir):
        raise FileNotFoundError(f"cwd {workdir} is not a directory")
    who = "root" if as_root else user.pw_name
    remote, kind, client = request_origin.get()
    logger.info("audit device_run as=%s cwd=%s origin=%s client=%s via=%s: %s", who, workdir, remote, client, kind,
                command if len(command) <= LOGGED_CHARS else command[:LOGGED_CHARS] + "…")

    kwargs: dict[str, Any] = {}
    if switch:
        kwargs = {"user": user.pw_uid, "group": user.pw_gid,
                  "extra_groups": [g for g in os.getgrouplist(user.pw_name, user.pw_gid) if g != user.pw_gid]}
    # Our own pipes, not asyncio's: Process.wait() waits until its pipes close, which a backgrounded child
    # (`server &`) holding them would delay until it exits (seen on CI's Python 3.14 build).
    out_r, out_w = os.pipe()
    err_r, err_w = os.pipe()
    stdin_file = tempfile.TemporaryFile() if stdin is not None else None
    if stdin_file is not None:
        stdin_file.write(stdin.encode())
        stdin_file.seek(0)
    t0 = time.monotonic()
    try:
        proc = await asyncio.create_subprocess_exec(
            "/bin/bash", "-c", command, cwd=workdir, env=_env(user, as_root), start_new_session=True,
            stdin=stdin_file if stdin_file is not None else asyncio.subprocess.DEVNULL,
            stdout=out_w, stderr=err_w, **kwargs)
    except BaseException:
        os.close(out_r)
        os.close(err_r)
        raise
    finally:
        os.close(out_w)
        os.close(err_w)
        if stdin_file is not None:
            stdin_file.close()
    out, err = _Capped(cap), _Capped(cap)
    readers = [asyncio.create_task(out.read(out_r)), asyncio.create_task(err.read(err_r))]
    timed_out = False
    try:
        await asyncio.wait_for(proc.wait(), timeout)
    except asyncio.TimeoutError:
        timed_out = True
        _kill_group(proc, signal.SIGTERM)
        try:
            await asyncio.wait_for(proc.wait(), 2)
        except asyncio.TimeoutError:
            _kill_group(proc, signal.SIGKILL)
            await proc.wait()
    # A backgrounded child (`server &`) keeps the pipes open and keeps running; stop reading instead of waiting.
    _, pending = await asyncio.wait(readers, timeout=BACKGROUND_GRACE)
    for t in pending:
        t.cancel()
    await asyncio.gather(*readers, return_exceptions=True)
    result: dict[str, Any] = {
        "exit_code": proc.returncode,
        "stdout": out.kept.decode(errors="replace"),
        "stderr": err.kept.decode(errors="replace"),
        "timed_out": timed_out,
        "duration_ms": round((time.monotonic() - t0) * 1000),
        "user": who,
        "cwd": workdir,
    }
    if pending:
        result["background"] = "child processes still hold the output open; they keep running (redirect their output)"
    if out.total > len(out.kept) or err.total > len(err.kept):
        result["truncated"] = {"stdout_bytes": out.total, "stderr_bytes": err.total, "kept": cap}
    return result
