"""Tools about the loader, plugins and the device itself."""
import os
import platform
import sys
from typing import Any

from ..loader.plugins import list_plugins, schedule_loader_restart
from . import ToolRegistry


def require_confirm(confirm: object, what: str) -> None:
    if confirm is not True:
        raise ValueError(f"{what}; call again with confirm: true to go ahead")


def register(reg: ToolRegistry) -> None:
    @reg.add("device_info", "Decky Loader version and home, the desktop user, the backend's uid, Python runtime, "
                            "kernel and OS release. Installed plugins: plugin_list; whether it answers: device_status.")
    async def device_info() -> dict[str, Any]:
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
            "decky_version": os.environ.get("DECKY_VERSION", ""),
            "decky_home": os.environ.get("DECKY_HOME", ""),
            "decky_user": os.environ.get("DECKY_USER", ""),
            "running_as_uid": os.getuid(),
            "python": sys.version,
            "kernel": platform.release(),
            "os": {k: os_release.get(k) for k in ("PRETTY_NAME", "IMAGE_ID", "VERSION_ID")},
        }

    @reg.add("plugin_list", "Plugins installed under ~/homebrew/plugins with their plugin.json metadata; 'name' is what "
                            "every tool's plugin argument takes ('dir' is only where it is installed). 'mcp_tools' lists the MCP tools a plugin registered from "
                            "its frontend, and the ones refused with the reason.")
    async def plugin_list() -> list[dict[str, Any]]:
        plugins = await list_plugins()
        for p in plugins if reg.plugin_tools else []:
            if tools := reg.plugin_tools.of_plugin(p["dir"]):
                p["mcp_tools"] = tools
        return plugins

    @reg.add(
        "toolkit_stacks",
        "Decky Toolkit's own backend: the stack of every thread and asyncio task, and event loop stalls (the loop "
        "watchdog logs a stack whenever the loop stops answering for 2 s, e.g. a hang during _unload). For finding "
        "hangs and leaked tasks in this plugin; other plugins' backends are separate processes.",
    )
    async def toolkit_stacks() -> dict[str, Any]:
        from .. import diagnostics
        return diagnostics.snapshot()

    @reg.add(
        "loader_restart",
        "Restart plugin_loader.service (reloads every plugin, including this server). "
        "The restart is scheduled 1s out so this call can return first; reconnect afterwards. "
        "Requires confirm: true.",
        {"properties": {"confirm": {"type": "boolean", "description": "must be true"}}, "required": ["confirm"]},
    )
    async def loader_restart(confirm: bool = False) -> str:
        require_confirm(confirm, "loader_restart restarts every plugin and drops this connection for a few seconds")
        await schedule_loader_restart()
        return "plugin_loader restart scheduled in ~1s. The MCP server will drop and come back on the same port."
