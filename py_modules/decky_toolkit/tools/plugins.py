"""Installing and reloading plugins; shared by the MCP tools and the REST routes."""
import asyncio
import base64
import binascii
import json
import logging
import os
import shlex
from typing import Any

from ..steam import cdp
from ..loader.install import install_plugin_zip
from . import ToolRegistry
from .system import plugins_dir, require_confirm, run

RESTART_MODES = ("loader", "plugin", "none")
log = logging.getLogger("decky_toolkit.plugins")


def plugin_name(dirname: str) -> str:
    if not dirname or "/" in dirname or dirname.startswith("."):
        raise ValueError("dir must be a bare plugin directory name")
    path = os.path.join(plugins_dir(), dirname, "plugin.json")
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


async def install(src: str | bytes, restart: str = "loader", logger: logging.Logger = log) -> dict[str, Any]:
    if restart not in RESTART_MODES:
        raise ValueError(f"restart must be one of {', '.join(RESTART_MODES)}")
    if restart != "loader":
        installed = await asyncio.to_thread(install_plugin_zip, src, plugins_dir(), logger=logger)
        if restart == "plugin":
            await reload_plugin(installed["dir"])
        return {"installed": installed, "restarted": restart}
    # Same filesystem as plugins/, so the final mv is a rename.
    pending = os.path.join(os.path.dirname(plugins_dir()), ".decky-toolkit-pending")
    installed = await asyncio.to_thread(install_plugin_zip, src, pending, logger=logger)
    await _swap_while_stopped(os.path.join(pending, installed["dir"]), os.path.join(plugins_dir(), installed["dir"]))
    return {"installed": installed, "restarted": restart}


def register(reg: ToolRegistry) -> None:
    @reg.add(
        "plugin_install",
        "Install a Decky plugin zip (either '<dir>/...' as the single top-level directory or files at the zip root) "
        "into ~/homebrew/plugins, replacing any existing copy atomically. Give either 'path' (a zip on the device) "
        "or 'zip_base64'. restart: 'loader' (default; 1s after the reply the loader is stopped, the new files are "
        "swapped in and it starts again), 'plugin' (re-import just this plugin, backend and frontend, without a "
        "loader restart; it must already be loaded) or 'none' (a plugin with the 'debug' flag is then re-imported "
        "by the loader's file watcher within a few seconds). restart 'loader' requires confirm: true.",
        {
            "properties": {
                "path": {"type": "string", "description": "Absolute path of a zip on the device"},
                "zip_base64": {"type": "string", "description": "The zip file, base64-encoded"},
                "restart": {"type": "string", "enum": list(RESTART_MODES), "default": "loader"},
                "confirm": {"type": "boolean", "description": "must be true when restart is 'loader'"},
            },
        },
    )
    async def plugin_install(path: str | None = None, zip_base64: str | None = None, restart: str = "loader",
                             confirm: bool = False) -> dict[str, Any]:
        if (path is None) == (zip_base64 is None):
            raise ValueError("give exactly one of 'path' or 'zip_base64'")
        if restart == "loader":
            require_confirm(confirm, "restart 'loader' restarts every plugin and drops this connection for a few "
                                     "seconds (use restart 'plugin' to reload just this one)")
        if path is not None:
            if not os.path.isabs(path):
                raise ValueError("path must be absolute")
            if not os.path.isfile(path):
                raise FileNotFoundError(path)
            return await install(path, restart)
        try:
            data = base64.b64decode(zip_base64 or "", validate=True)
        except binascii.Error as e:
            raise ValueError(f"zip_base64 is not valid base64: {e}") from None
        return await install(data, restart)

    @reg.add(
        "plugin_reload",
        "Reload one plugin in place, without restarting the loader. mode 'backend' (default) restarts its backend "
        "and waits until the new frontend bundle is loaded; 'frontend' re-imports only dist/index.js (~10 ms, the "
        "backend keeps running). Reopens the plugin's panel, its route, settings tab and focus if the user was there "
        "(never over a running game) and returns errors the plugin logged while loading. Reloading Decky Toolkit's "
        "own backend only schedules it ('scheduled': the connection drops for a few seconds).",
        {"properties": {"plugin": {"type": "string", "description": "Directory or plugin.json name (plugin_list)"},
                        "mode": {"type": "string", "enum": ["backend", "frontend"], "default": "backend"}},
         "required": ["plugin"]},
    )
    async def plugin_reload(plugin: str, mode: str = "backend") -> dict[str, Any]:
        from ..loader import live  # live builds on this module
        return await live.reload(resolve_plugin(plugin)[0], mode)
