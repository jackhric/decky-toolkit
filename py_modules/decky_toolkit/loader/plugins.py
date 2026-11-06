"""Installed plugins: listing, name lookup, install and reload; shared by the MCP tools and the REST routes."""
import asyncio
import json
import logging
import os
import shlex
from typing import TYPE_CHECKING, Any

from ..steam import cdp
from ..system import run
from .install import install_plugin_zip

if TYPE_CHECKING:
    from ..server.events import EventHub

RESTART_MODES = ("loader", "plugin", "none")
log = logging.getLogger("decky_toolkit.plugins")


def plugins_dir() -> str:
    return os.path.join(os.environ.get("DECKY_HOME", ""), "plugins")


def check_dir_name(dirname: str) -> str:
    """A plugin directory name as it appears under plugins/ and logs/: no path separators, not hidden."""
    if not isinstance(dirname, str) or not dirname or "/" in dirname or dirname.startswith("."):
        raise ValueError(f"{dirname!r} is not a bare plugin directory name")
    return dirname


def plugin_name(dirname: str) -> str:
    path = os.path.join(plugins_dir(), check_dir_name(dirname), "plugin.json")
    try:
        with open(path) as f:
            name = json.load(f).get("name")
    except FileNotFoundError:
        raise FileNotFoundError(f"no plugin installed at {os.path.dirname(path)}") from None
    if not isinstance(name, str):
        raise ValueError(f"{path} has no string 'name'")
    return name


def resolve_plugin(plugin: str) -> tuple[str, str]:
    """(dir, name) of an installed plugin given either its directory or its plugin.json name."""
    if not plugin or not isinstance(plugin, str):
        raise ValueError("plugin must be a plugin directory or name (see plugin_list)")
    if "/" not in plugin and not plugin.startswith(".") and os.path.isfile(os.path.join(plugins_dir(), plugin, "plugin.json")):
        return plugin, plugin_name(plugin)
    try:
        dirs = sorted(os.listdir(plugins_dir()))
    except FileNotFoundError:
        dirs = []
    for d in dirs:
        try:
            if plugin_name(d) == plugin:
                return d, plugin
        except (FileNotFoundError, ValueError, OSError):
            continue
    raise FileNotFoundError(f"no installed plugin with directory or name {plugin!r} (see plugin_list)")


async def _reload_by_name(name: str) -> Any:
    # The loader's own websocket on :1337 is single-client (the Steam UI holds it), so ask the
    # frontend in SharedJSContext to forward the call over its existing connection.
    return await cdp.evaluate_in(None, f"window.DeckyBackend.call('loader/reload_plugin', {json.dumps(name)})")


async def reload_plugin(dirname: str) -> dict[str, Any]:
    name = plugin_name(dirname)
    own_dir = os.path.basename(os.environ.get("DECKY_PLUGIN_DIR", "").rstrip("/"))
    if dirname == own_dir:
        # Reloading ourselves kills this process, so let the caller's reply go out first.
        asyncio.get_running_loop().call_later(1, lambda: asyncio.ensure_future(_reload_by_name(name)))
        return {"dir": dirname, "name": name, "scheduled": True}
    await _reload_by_name(name)
    return {"dir": dirname, "name": name, "scheduled": False}


async def _swap_while_stopped(staged: str, target: str) -> None:
    # Swapping a debug-flagged or new plugin into place makes the loader's file watcher import it a
    # few seconds later. If that lands while the loader is stopping, the new backend is started
    # outside the unit and orphaned, and an orphan's socket reader spins on EOF (5.9 GB RSS within
    # 76 s, 2026-11-04), even with the restart delayed 5 s. So swap the dir
    # while the loader is down, from a transient unit outside its cgroup.
    old = shlex.quote(staged + ".old")
    script = (
        f"systemctl stop plugin_loader; rm -rf {old}; "
        f"if [ -e {shlex.quote(target)} ]; then mv {shlex.quote(target)} {old}; fi; "
        f"mv {shlex.quote(staged)} {shlex.quote(target)}; rm -rf {old}; systemctl start plugin_loader"
    )
    code, out = await run("systemd-run", "--on-active=1", "--timer-property=AccuracySec=100ms", "sh", "-c", script)
    if code != 0:
        raise RuntimeError(out)


async def install(src: str | bytes, restart: str, events: "EventHub", logger: logging.Logger = log) -> dict[str, Any]:
    if restart not in RESTART_MODES:
        raise ValueError(f"restart must be one of {', '.join(RESTART_MODES)}")
    if restart != "loader":
        installed = await asyncio.to_thread(install_plugin_zip, src, plugins_dir(), logger=logger)
        events.refresh("plugins")
        if restart == "plugin":
            try:
                await reload_plugin(installed["dir"])
            except cdp.CdpError as e:
                raise cdp.CdpError(f"installed, but plugin reload failed: {e}") from e
        return {"installed": installed, "restarted": restart}
    # Same filesystem as plugins/, so the final mv is a rename.
    pending = os.path.join(os.path.dirname(plugins_dir()), ".decky-toolkit-pending")
    installed = await asyncio.to_thread(install_plugin_zip, src, pending, logger=logger)
    await _swap_while_stopped(os.path.join(pending, installed["dir"]), os.path.join(plugins_dir(), installed["dir"]))
    return {"installed": installed, "restarted": restart}


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
