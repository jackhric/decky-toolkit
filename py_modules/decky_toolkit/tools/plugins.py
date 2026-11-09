"""plugin_install and plugin_reload."""
import base64
import binascii
import os
from typing import Any

from ..loader import live
from ..loader.plugins import RESTART_MODES, install
from ..server.events import EventHub
from . import ToolRegistry
from .system import require_confirm


def register(reg: ToolRegistry, events: EventHub) -> None:
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
            return await install(path, restart, events)
        try:
            data = base64.b64decode(zip_base64 or "", validate=True)
        except binascii.Error as e:
            raise ValueError(f"zip_base64 is not valid base64: {e}") from None
        return await install(data, restart, events)

    @reg.add(
        "plugin_reload",
        "Reload one plugin without restarting the loader or Steam. After a UI-only change use mode 'frontend': it "
        "loads the new dist/index.js in ~10 ms and the backend keeps running (its state survives). mode 'backend' "
        "(default) also restarts the backend, then waits for the new UI. Either way the plugin's panel, route, "
        "settings tab and focused element come back if the user was there (never over a running game), and errors "
        "the plugin logged while loading are returned. Reloading Decky Toolkit's own backend only schedules it "
        "('scheduled': the connection drops for a few seconds).",
        {"properties": {"plugin": {"type": "string", "description": "The plugin.json name (plugin_list)"},
                        "mode": {"type": "string", "enum": ["backend", "frontend"], "default": "backend"}},
         "required": ["plugin"]},
    )
    async def plugin_reload(plugin: str, mode: str = "backend") -> dict[str, Any]:
        return await live.reload(plugin, mode)
