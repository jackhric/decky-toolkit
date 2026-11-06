"""Subprocess and file helpers shared across the backend."""
import asyncio
import os
import pwd


def desktop_user() -> pwd.struct_passwd:
    """Decky's user (DECKY_USER, the owner of ~/homebrew, whom Steam runs as); the current user outside the loader."""
    name = os.environ.get("DECKY_USER")
    try:
        return pwd.getpwnam(name) if name else pwd.getpwuid(os.getuid())
    except KeyError:
        return pwd.getpwuid(os.getuid())


def user_home() -> str:
    return os.environ.get("DECKY_USER_HOME") or desktop_user().pw_dir


def user_runtime_dir() -> str:
    """The desktop session's XDG_RUNTIME_DIR: PipeWire, gamescope, D-Bus and X live there, for root as well."""
    return f"/run/user/{desktop_user().pw_uid}"


def clean_env() -> dict[str, str]:
    # The PyInstaller-launched loader exports LD_LIBRARY_PATH pointing at its own libs, which breaks
    # system binaries (notably /usr/bin/python3) on Bazzite. Strip it like the loader's own run() does.
    return {k: v for k, v in os.environ.items() if k != "LD_LIBRARY_PATH"}


async def run(*argv: str, timeout: float = 20) -> tuple[int, str]:
    proc = await asyncio.create_subprocess_exec(*argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT, env=clean_env())
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout)
    except asyncio.TimeoutError:
        proc.kill()
        raise
    return proc.returncode or 0, out.decode(errors="replace")


def tail(path: str, lines: int) -> str:
    """The last `lines` lines, read backwards in blocks so a long log is not read whole."""
    with open(path, "rb") as f:
        f.seek(0, os.SEEK_END)
        size = f.tell()
        block = 64 * 1024
        data = b""
        while size > 0 and data.count(b"\n") <= lines:
            step = min(block, size)
            size -= step
            f.seek(size)
            data = f.read(step) + data
    return b"\n".join(data.splitlines()[-lines:]).decode(errors="replace")
