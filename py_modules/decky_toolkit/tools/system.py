"""Tools about the loader, plugins, logs and files on the device."""
import asyncio
import base64
import json
import os
import platform
import sys
from typing import Any

from . import ToolRegistry
from .guard import check_read, check_write


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default)


def plugins_dir() -> str:
    return os.path.join(_env("DECKY_HOME"), "plugins")


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


def require_confirm(confirm: object, what: str) -> None:
    if confirm is not True:
        raise ValueError(f"{what}; call again with confirm: true to go ahead")


async def schedule_loader_restart() -> None:
    # A transient systemd timer restarts the loader from outside our process tree 1s later, so the
    # caller's reply gets out before the loader kills this backend.
    code, out = await run("systemd-run", "--on-active=1", "--timer-property=AccuracySec=100ms",
                          "systemctl", "restart", "plugin_loader")
    if code != 0:
        raise RuntimeError(out)


async def list_plugins() -> list[dict[str, Any]]:
    out = []
    root = plugins_dir()
    for entry in sorted(os.listdir(root)) if os.path.isdir(root) else []:
        path = os.path.join(root, entry)
        if not os.path.isdir(path):
            continue
        info: dict[str, Any] = {"dir": entry, "path": path}
        try:
            with open(os.path.join(path, "plugin.json")) as f:
                meta = json.load(f)
            info.update({k: meta.get(k) for k in ("name", "author", "flags", "api_version")})
            with open(os.path.join(path, "package.json")) as f:
                info["version"] = json.load(f).get("version")
        except (OSError, json.JSONDecodeError) as e:
            info["error"] = str(e)
        info["has_backend"] = os.path.exists(os.path.join(path, "main.py"))
        out.append(info)
    return out


def register(reg: ToolRegistry) -> None:
    @reg.add("decky_status", "Report Decky Loader version, host OS, Python runtime and installed plugins.")
    async def decky_status() -> dict[str, Any]:
        os_release: dict[str, str] = {}
        try:
            with open("/etc/os-release") as f:
                for line in f:
                    k, _, v = line.strip().partition("=")
                    if k:
                        os_release[k] = v.strip('"')
        except OSError:
            pass
        return {
            "decky_version": _env("DECKY_VERSION"),
            "decky_home": _env("DECKY_HOME"),
            "decky_user": _env("DECKY_USER"),
            "running_as_uid": os.getuid(),
            "python": sys.version,
            "kernel": platform.release(),
            "os": {k: os_release.get(k) for k in ("PRETTY_NAME", "IMAGE_ID", "VERSION_ID")},
            "plugins": await list_plugins(),
        }

    reg.add("list_plugins", "List plugins installed under ~/homebrew/plugins with their plugin.json metadata.")(list_plugins)

    @reg.add(
        "backend_stacks",
        "Decky Toolkit's own backend: the stack of every thread and asyncio task, and event loop stalls (the loop "
        "watchdog logs a stack whenever the loop stops answering for 2 s, e.g. a hang during _unload). For finding "
        "hangs and leaked tasks in this plugin; other plugins' backends are separate processes.",
    )
    async def backend_stacks() -> dict[str, Any]:
        from .. import diagnostics
        return diagnostics.snapshot()

    @reg.add(
        "read_plugin_log",
        "Tail a plugin's backend log from ~/homebrew/logs/<plugin_dir>/. Omit 'file' to pick the newest log.",
        {
            "properties": {
                "plugin_dir": {"type": "string", "description": "Plugin directory name, as returned by list_plugins"},
                "lines": {"type": "integer", "default": 200, "minimum": 1, "maximum": 5000},
                "file": {"type": "string", "description": "Specific log file name inside the plugin's log dir"},
            },
            "required": ["plugin_dir"],
        },
    )
    async def read_plugin_log(plugin_dir: str, lines: int = 200, file: str | None = None) -> dict[str, Any]:
        if "/" in plugin_dir or plugin_dir.startswith("."):
            raise ValueError("plugin_dir must be a bare directory name")
        log_dir = os.path.join(_env("DECKY_HOME"), "logs", plugin_dir)
        if not os.path.isdir(log_dir):
            raise FileNotFoundError(f"No log dir {log_dir}")
        files = sorted(os.listdir(log_dir), key=lambda n: os.path.getmtime(os.path.join(log_dir, n)), reverse=True)
        if not files:
            return {"log_dir": log_dir, "files": [], "text": ""}
        chosen = file or files[0]
        if chosen not in files:
            raise FileNotFoundError(f"{chosen} not in {files}")
        return {"log_dir": log_dir, "files": files, "file": chosen, "text": tail(os.path.join(log_dir, chosen), lines)}

    @reg.add(
        "loader_log",
        "Tail the Decky Loader systemd journal (plugin_loader.service). Includes every plugin's stdout/stderr.",
        {"properties": {"lines": {"type": "integer", "default": 200, "minimum": 1, "maximum": 5000},
                        "grep": {"type": "string", "description": "Optional case-insensitive substring filter"}}},
    )
    async def loader_log(lines: int = 200, grep: str | None = None) -> str:
        argv = ["journalctl", "-u", "plugin_loader", "--no-pager", "-o", "short-iso", "-n", str(lines if not grep else max(lines * 10, 2000))]
        code, out = await run(*argv)
        if code != 0:
            raise RuntimeError(out)
        if grep:
            needle = grep.lower()
            out = "\n".join(l for l in out.splitlines() if needle in l.lower())
            out = "\n".join(out.splitlines()[-lines:])
        return out

    @reg.add(
        "restart_loader",
        "Restart plugin_loader.service (reloads every plugin, including this server). "
        "The restart is scheduled 1s out so this call can return first; reconnect afterwards. "
        "Requires confirm: true.",
        {"properties": {"confirm": {"type": "boolean", "description": "must be true"}}, "required": ["confirm"]},
    )
    async def restart_loader(confirm: bool = False) -> str:
        require_confirm(confirm, "restart_loader restarts every plugin and drops this connection for a few seconds")
        await schedule_loader_restart()
        return "plugin_loader restart scheduled in ~1s. The MCP server will drop and come back on the same port."

    @reg.add(
        "write_file",
        "Write a text file on the device (runs as root). Intended for dropping config or test fixtures during development. "
        "Refuses Steam credential/session files, Steam library folder lists and SSH keys.",
        {"properties": {"path": {"type": "string"}, "content": {"type": "string"}, "mode": {"type": "string", "default": "0644"}},
         "required": ["path", "content"]},
    )
    async def write_file(path: str, content: str, mode: str = "0644") -> str:
        if not os.path.isabs(path):
            raise ValueError("path must be absolute")
        check_write(path)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            f.write(content)
        os.chmod(path, int(mode, 8))
        return f"wrote {len(content.encode())} bytes to {path}"

    @reg.add(
        "read_file",
        "Read a text file on the device (runs as root). Large files are truncated to max_bytes from the start. "
        "Refuses Steam credential/session files (loginusers.vdf, config.vdf, local.vdf, ssfn*) and SSH keys.",
        {"properties": {"path": {"type": "string"}, "max_bytes": {"type": "integer", "default": 200000}}, "required": ["path"]},
    )
    async def read_file(path: str, max_bytes: int = 200_000) -> dict[str, Any]:
        if not os.path.isabs(path):
            raise ValueError("path must be absolute")
        check_read(path)
        size = os.path.getsize(path)
        with open(path, "rb") as f:
            data = f.read(max_bytes)
        try:
            text = data.decode()
        except UnicodeDecodeError:
            return {"path": path, "size": size, "base64": base64.b64encode(data).decode(), "truncated": size > max_bytes}
        return {"path": path, "size": size, "text": text, "truncated": size > max_bytes}
