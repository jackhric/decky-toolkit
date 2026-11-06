"""Steam library tools: list, inspect, launch and terminate apps."""
from typing import Any

from ..steam.apps import Apps
from . import ToolRegistry

APPID = {"type": "integer", "description": "Steam appid (or a non-Steam shortcut's appid from apps_list)"}


def register(reg: ToolRegistry, apps: Apps | None = None) -> None:
    lib = apps or Apps()

    @reg.add(
        "apps_list",
        "List Steam library apps from the Steam client: appid, name, type, installed, running, install_dir, "
        "compat_tool (Proton version or Steam Linux Runtime for native titles), size_on_disk, last_played, library. "
        "installed_only (default true) hides apps that are not installed; query filters by name substring or appid; "
        "include_tools adds Proton/runtimes.",
        {"properties": {
            "installed_only": {"type": "boolean", "default": True},
            "query": {"type": "string"},
            "include_tools": {"type": "boolean", "default": False},
        }},
    )
    async def apps_list(installed_only: bool = True, query: str | None = None, include_tools: bool = False) -> dict[str, Any]:
        return await lib.list(installed_only, query, include_tools)

    @reg.add(
        "apps_running",
        "Apps Steam reports as running (SteamUIStore.RunningApps), each with the pid of its `reaper SteamLaunch` "
        "process and the processes below it.",
    )
    async def apps_running() -> dict[str, Any]:
        return await lib.running()

    @reg.add(
        "app_info",
        "One app in detail: Steam client details (developer, platforms, compat tool, launch options, build, cloud) "
        "plus its resolved dirs (install dir, Proton prefix and its user dirs, Steam Cloud userdata, shader cache, "
        "XDG dirs for native titles; same as game_dirs) and its processes when running.",
        {"properties": {"appid": APPID}, "required": ["appid"]},
    )
    async def app_info(appid: int) -> dict[str, Any]:
        return await lib.info(appid)

    @reg.add(
        "app_launch",
        "Launch an installed app like pressing Play (SteamClient.Apps.RunGame). Waits up to `wait` seconds for Steam "
        "to report it running. If it does not start, Steam may be showing a dialog (another session playing, EULA, "
        "update); check screen_capture and never confirm a 'disconnect the other session' dialog blindly.",
        {"properties": {"appid": APPID, "wait": {"type": "number", "default": 15, "minimum": 0, "maximum": 60}},
         "required": ["appid"]},
    )
    async def app_launch(appid: int, wait: float = 15) -> dict[str, Any]:
        return await lib.launch(appid, wait)

    @reg.add(
        "app_terminate",
        "Force-quit a running app (SteamClient.Apps.TerminateApp), losing unsaved progress. Requires confirm=true.",
        {"properties": {"appid": APPID, "confirm": {"type": "boolean"},
                        "wait": {"type": "number", "default": 15, "minimum": 0, "maximum": 60}},
         "required": ["appid", "confirm"]},
    )
    async def app_terminate(appid: int, confirm: bool = False, wait: float = 15) -> dict[str, Any]:
        return await lib.terminate(appid, confirm, wait)
