"""App dirs, save locations and a guarded file browser."""
import asyncio
import base64
from typing import Any

from ..games import files as games
from ..steam.apps import Apps
from . import ToolRegistry

APPID = {"type": "integer", "description": "Steam appid"}


def register(reg: ToolRegistry, apps: Apps | None = None) -> None:
    lib = apps or Apps()

    @reg.add(
        "app_dirs",
        "Resolve one title's directories: install dir, Proton prefix (compatdata/<appid>/pfx) and its steamuser "
        "AppData/Roaming, AppData/Local, AppData/LocalLow, Documents and Saved Games (with subdirs named after the "
        "game or developer), Steam Cloud userdata/<account>/<appid>/remote, shader cache, and for native Linux titles "
        "matching ~/.local/share, ~/.config and ~/.config/unity3d entries. Each entry says whether it exists.",
        {"properties": {"appid": APPID}, "required": ["appid"]},
    )
    async def app_dirs(appid: int) -> dict[str, Any]:
        return await lib.dirs(appid)

    @reg.add(
        "app_saves",
        "Likely save files for a title, best first: files Steam Cloud tracks (remotecache.vdf, mapped to local "
        "paths) and the cloud remote dir, then dirs Steam Auto-Cloud marked (steam_autocloud.vdf), then heuristics "
        "(save-like names under dirs named after the game). Each has path, size, mtime and found_by.",
        {"properties": {"appid": APPID, "limit": {"type": "integer", "default": 40, "minimum": 1, "maximum": 500}},
         "required": ["appid"]},
    )
    async def app_saves(appid: int, limit: int = 40) -> dict[str, Any]:
        return await lib.saves(appid, limit)

    @reg.add(
        "fs_list",
        "List a directory on the device (as root; ~ is the desktop user's home): name, type, size, mtime, up to "
        f"depth levels deep (1-{games.MAX_LIST_DEPTH}), optionally filtered by a glob on the name (or on the relative "
        f"path if the glob has a '/'). At most {games.MAX_LIST_ENTRIES} entries. Read files with fs_read.",
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
        return await asyncio.to_thread(lambda: games.fs_delete(path, confirm, games.device_delete_roots()))

    @reg.add(
        "fs_read",
        "Read a file on the device (as root; ~ is the desktop user's home): text, or base64 if it is not UTF-8. "
        "Longer files are cut to max_bytes from the start. Refuses Steam credential/session files and SSH keys.",
        {"properties": {"path": {"type": "string"}, "max_bytes": {"type": "integer", "default": 200000, "minimum": 1}},
         "required": ["path"]},
    )
    async def fs_read(path: str, max_bytes: int = 200_000) -> dict[str, Any]:
        data, size = await asyncio.to_thread(games.fs_read, path, max_bytes=max_bytes, truncate=True)
        out: dict[str, Any] = {"path": path, "size": size, "truncated": size > len(data)}
        try:
            out["text"] = data.decode()
        except UnicodeDecodeError:
            out["base64"] = base64.b64encode(data).decode()
        return out

    @reg.add(
        "fs_write",
        "Write a text file anywhere on the device (as root; ~ is the desktop user's home), atomically, creating parent "
        "dirs. Without mode an existing file keeps its mode and a new one is 0644 (e.g. 0755 for a script); either way "
        "it is owned like the file it replaces or its parent dir. Refuses Steam credential/session files, Steam "
        "library folder lists and SSH keys.",
        {"properties": {"path": {"type": "string"}, "content": {"type": "string"}, "mode": {"type": "string"}},
         "required": ["path", "content"]},
    )
    async def fs_write(path: str, content: str, mode: str | None = None) -> dict[str, Any]:
        bits = None if mode is None else games.parse_mode(mode)
        return await asyncio.to_thread(lambda: games.fs_write(path, content.encode(), None, mode=bits))
