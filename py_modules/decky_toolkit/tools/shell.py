"""The device_run tool."""
from typing import Any

from .. import shell
from . import ToolRegistry


def register(reg: ToolRegistry) -> None:
    @reg.add(
        "device_run",
        "Run a shell command on the device (bash -c) and return {exit_code, stdout, stderr, timed_out, duration_ms, "
        "user, cwd}. Runs as the desktop user (the one Steam runs as) with its HOME, XDG_RUNTIME_DIR, D-Bus and "
        "DISPLAY=:0, so pw-dump, gamescopectl, xdotool and systemctl --user work; root: true runs as root (same "
        "runtime dir) for system changes, other users' files and journalctl. A non-zero exit is a normal result. On "
        "timeout the whole process group is stopped. Output beyond max_output bytes per stream is cut ('truncated' "
        "says how much there was). Every command is written to the plugin log.",
        {"properties": {
            "command": {"type": "string", "description": "bash command line"},
            "cwd": {"type": "string", "description": "Working directory; default the user's home (/root for root)"},
            "timeout": {"type": "number", "default": shell.DEFAULT_TIMEOUT, "minimum": 0.1, "maximum": shell.MAX_TIMEOUT},
            "root": {"type": "boolean", "default": False},
            "stdin": {"type": "string", "description": "Text fed to the command's stdin"},
            "max_output": {"type": "integer", "default": shell.DEFAULT_OUTPUT, "minimum": 1024, "maximum": shell.MAX_OUTPUT},
        }, "required": ["command"]},
    )
    async def device_run(command: str, cwd: str | None = None, timeout: float = shell.DEFAULT_TIMEOUT,
                         root: bool = False, stdin: str | None = None,
                         max_output: int = shell.DEFAULT_OUTPUT) -> dict[str, Any]:
        return await shell.run_command(command, cwd, timeout, root, stdin, max_output, logger=reg.log)
