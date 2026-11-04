"""Game dirs, save locations, Proton logs and a guarded file browser."""
import asyncio
import os
from typing import Any

from .. import games
from ..apps import Apps
from . import ToolRegistry

APPID = {"type": "integer", "description": "Steam appid"}


def delete_roots() -> list[tuple[str, int]]:
    root = games.steam_root()
    return games.delete_roots(root, games.library_folders(root), os.environ.get("DECKY_PLUGIN_RUNTIME_DIR"))


def register(reg: ToolRegistry, apps: Apps | None = None) -> None:
    lib = apps or Apps()

    @reg.add(
        "game_dirs",
        "Resolve one title's directories: install dir, Proton prefix (compatdata/<appid>/pfx) and its steamuser "
        "AppData/Roaming, AppData/Local, AppData/LocalLow, Documents and Saved Games (with subdirs named after the "
        "game or developer), Steam Cloud userdata/<account>/<appid>/remote, shader cache, and for native Linux titles "
        "matching ~/.local/share, ~/.config and ~/.config/unity3d entries. Each entry says whether it exists.",
        {"properties": {"appid": APPID}, "required": ["appid"]},
    )
    async def game_dirs(appid: int) -> dict[str, Any]:
        return await lib.dirs(appid)

    @reg.add(
        "game_saves",
        "Likely save files for a title, best first: files Steam Cloud tracks (remotecache.vdf, mapped to local "
        "paths) and the cloud remote dir, then dirs Steam Auto-Cloud marked (steam_autocloud.vdf), then heuristics "
        "(save-like names under dirs named after the game). Each has path, size, mtime and found_by.",
        {"properties": {"appid": APPID, "limit": {"type": "integer", "default": 40, "minimum": 1, "maximum": 500}},
         "required": ["appid"]},
    )
    async def game_saves(appid: int, limit: int = 40) -> dict[str, Any]:
        return await lib.saves(appid, limit)

    @reg.add(
        "proton_log",
        "Logs for one title: ~/steam-<appid>.log (written when the game runs with PROTON_LOG=1) plus the lines "
        "mentioning the appid in Steam's logs/ (compat, gameprocess, console, content, cloud, shader).",
        {"properties": {"appid": APPID, "lines": {"type": "integer", "default": 200, "minimum": 1, "maximum": 5000}},
         "required": ["appid"]},
    )
    async def proton_log(appid: int, lines: int = 200) -> dict[str, Any]:
        if isinstance(appid, bool) or not isinstance(appid, int) or appid <= 0:
            raise ValueError("appid must be a positive integer")
        return await asyncio.to_thread(games.proton_log, appid, max(1, min(int(lines), 5000)))

    @reg.add(
        "fs_list",
        "List a directory on the device (as root; ~ is the desktop user's home): name, type, size, mtime, up to "
        f"depth levels deep (1-{games.MAX_LIST_DEPTH}), optionally filtered by a glob on the name (or on the relative "
        f"path if the glob has a '/'). At most {games.MAX_LIST_ENTRIES} entries. Read files with read_file.",
        {"properties": {"path": {"type": "string"}, "depth": {"type": "integer", "default": 1, "minimum": 1,
                                                                "maximum": games.MAX_LIST_DEPTH},
                        "glob": {"type": "string"}},
         "required": ["path"]},
    )
    async def fs_list(path: str, depth: int = 1, glob: str | None = None) -> dict[str, Any]:
        return await asyncio.to_thread(games.fs_list, path, depth, glob)

    @reg.add(
        "fs_stat",
        "Stat one path (does not follow a final symlink): type, size, mtime, mode, owner, link target, entry count.",
        {"properties": {"path": {"type": "string"}}, "required": ["path"]},
    )
    async def fs_stat(path: str) -> dict[str, Any]:
        return await asyncio.to_thread(games.fs_stat, path)

    @reg.add(
        "fs_delete",
        "Delete a file or directory tree. Only inside a game's install dir (steamapps/common/<game>/...), a "
        "compatdata/<appid> or shadercache/<appid> entry (the entry itself allowed, e.g. to reset a prefix), "
        "userdata/<account>/<appid>/... or the plugin's runtime dir. Requires confirm=true.",
        {"properties": {"path": {"type": "string"}, "confirm": {"type": "boolean"}}, "required": ["path", "confirm"]},
    )
    async def fs_delete(path: str, confirm: bool = False) -> dict[str, Any]:
        if confirm is not True:
            raise ValueError("fs_delete is destructive: pass confirm=true to delete")
        return await asyncio.to_thread(games.fs_delete, path, confirm, delete_roots())
