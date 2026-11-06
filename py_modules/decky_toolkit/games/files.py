"""Game install dirs, Proton prefixes, save locations and a guarded file browser.

The backend runs as root; every path that starts with ~ means the desktop user's home (DECKY_USER_HOME).
Everything here is plain filesystem work so it can be tested against a fake Steam tree.
"""
import fnmatch
import os
import pwd
import re
import shutil
import stat
import time
from datetime import datetime, timezone
from typing import Any, Iterable

from . import vdf
from ..guard import check_read, check_write, is_sensitive
from ..system import tail, user_home

STEAMID64_BASE = 76561197960265728
MAX_LIST_ENTRIES = 2000
MAX_LIST_DEPTH = 5
MAX_SCAN_FILES = 20000
SCAN_DEPTH = 6
PREFIX_USER_DIRS = (
    ("appdata_roaming", "AppData/Roaming"),
    ("appdata_local", "AppData/Local"),
    ("appdata_locallow", "AppData/LocalLow"),
    ("documents", "Documents"),
    ("saved_games", "Saved Games"),
)
_GENERIC_WORDS = {"the", "games", "game", "studio", "studios", "inc", "ltd", "llc", "entertainment", "interactive",
                  "software", "edition", "remastered", "goty", "complete", "digital", "publishing", "productions"}
_SAVE_DIR = re.compile(r"(^|[^a-z])(saves?|savegames?|savedata|saved|savefiles?|profiles?|slots?|userdata|storage)([^a-z]|$)", re.I)
_SAVE_EXT = {".sav", ".save", ".dat", ".json", ".bin", ".ess", ".fos", ".sl2", ".slot", ".profile", ".vdf", ".xml", ".db"}
_NOT_SAVE_EXT = {".dll", ".exe", ".so", ".pak", ".ucas", ".utoc", ".log", ".png", ".jpg", ".jpeg", ".dds", ".bik",
                 ".wav", ".ogg", ".mp3", ".mp4", ".webm", ".pdb", ".ttf", ".otf", ".cache", ".tmp", ".lnk", ".ico",
                 ".bk2", ".bnk", ".wem", ".assets", ".resource", ".ress", ".unity3d", ".mui", ".nls", ".tlb"}


class OutsideRoots(PermissionError):
    pass


def expand(path: str, home: str | None = None) -> str:
    if not isinstance(path, str) or not path:
        raise ValueError("path must be a non-empty string")
    if path == "~" or path.startswith("~/"):
        path = (home or user_home()) + path[1:]
    if not os.path.isabs(path):
        raise ValueError("path must be absolute (or start with ~/)")
    return os.path.normpath(path)


def iso(ts: float | int | None) -> str | None:
    if not ts:
        return None
    return datetime.fromtimestamp(float(ts), timezone.utc).isoformat(timespec="seconds")


def steam_root(home: str | None = None) -> str:
    home = home or user_home()
    for cand in (os.path.join(home, ".local/share/Steam"), os.path.join(home, ".steam/steam")):
        if os.path.isdir(os.path.join(cand, "steamapps")):
            return os.path.realpath(cand)
    return os.path.join(home, ".local/share/Steam")


def library_folders(root: str) -> list[str]:
    paths = [root]
    for rel in ("steamapps/libraryfolders.vdf", "config/libraryfolders.vdf"):
        try:
            data = vdf.load(os.path.join(root, rel))
        except OSError:
            continue
        for entry in (data.get("libraryfolders") or data.get("LibraryFolders") or {}).values():
            if isinstance(entry, dict) and entry.get("path"):
                paths.append(entry["path"])
            elif isinstance(entry, str) and os.path.isabs(entry):
                paths.append(entry)
    out, seen = [], set()
    for p in paths:
        real = os.path.realpath(p)
        if real not in seen and os.path.isdir(os.path.join(p, "steamapps")):
            seen.add(real)
            out.append(p)
    return out


def find_manifest(appid: int, libraries: Iterable[str]) -> dict[str, Any] | None:
    for lib in libraries:
        path = os.path.join(lib, "steamapps", f"appmanifest_{appid}.acf")
        try:
            state = vdf.load(path).get("AppState", {})
        except OSError:
            continue
        installdir = state.get("installdir") or ""
        return {
            "library": lib,
            "path": path,
            "name": state.get("name"),
            "installdir": installdir,
            "install_dir": os.path.join(lib, "steamapps", "common", installdir) if installdir else None,
            "size_on_disk": int(state["SizeOnDisk"]) if str(state.get("SizeOnDisk", "")).isdigit() else None,
            "last_updated": iso(int(state["LastUpdated"])) if str(state.get("LastUpdated", "")).isdigit() else None,
            "state_flags": int(state["StateFlags"]) if str(state.get("StateFlags", "")).isdigit() else None,
            "buildid": state.get("buildid"),
        }
    return None


def account_ids(root: str, appid: int | None = None) -> list[str]:
    """Steam account ids with a userdata dir, most recently used first; with appid, ones that have it first."""
    base = os.path.join(root, "userdata")
    try:
        ids = [d for d in os.listdir(base) if d.isdigit() and d != "0"]
    except OSError:
        return []

    def key(d: str) -> tuple[int, float]:
        has = appid is not None and os.path.isdir(os.path.join(base, d, str(appid)))
        try:
            mtime = os.path.getmtime(os.path.join(base, d, "config", "localconfig.vdf"))
        except OSError:
            mtime = 0.0
        return (1 if has else 0, mtime)

    return sorted(ids, key=key, reverse=True)


def account_id_from_steamid(steamid: str | int | None) -> str | None:
    try:
        sid = int(steamid or 0)
    except (TypeError, ValueError):
        return None
    return str(sid - STEAMID64_BASE) if sid > STEAMID64_BASE else None


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", s.lower())


def name_keys(*names: str | None) -> list[str]:
    keys: list[str] = []
    for name in names:
        if not name:
            continue
        whole = _norm(name)
        if len(whole) >= 3:
            keys.append(whole)
        for word in re.split(r"[^A-Za-z0-9]+", name):
            w = word.lower()
            if len(w) >= 4 and w not in _GENERIC_WORDS:
                keys.append(w)
    return list(dict.fromkeys(keys))


def name_matches(entry: str, keys: Iterable[str]) -> bool:
    n = _norm(entry)
    if len(n) < 3:
        return False
    return any(k in n or (len(n) >= 4 and n in k) for k in keys)


def _entry(path: str | None, **extra: Any) -> dict[str, Any]:
    if not path:
        return {"path": None, "exists": False, **extra}
    try:
        st = os.stat(path)
        return {"path": path, "exists": True, "mtime": iso(st.st_mtime), **extra}
    except OSError:
        return {"path": path, "exists": False, **extra}


def _matching_children(base: str, keys: list[str], depth: int = 2) -> list[str]:
    """Subdirs of base (two levels: Company/Product layouts) whose names match the game or developer."""
    found: list[str] = []
    try:
        level1 = [e for e in os.scandir(base) if e.is_dir(follow_symlinks=False)]
    except OSError:
        return found
    for e in level1:
        if name_matches(e.name, keys):
            found.append(e.path)
        elif depth > 1:
            try:
                found.extend(c.path for c in os.scandir(e.path)
                             if c.is_dir(follow_symlinks=False) and name_matches(c.name, keys))
            except OSError:
                pass
    return sorted(found)


def is_proton_tool(compat_tool: str | None) -> bool:
    return bool(compat_tool) and not compat_tool.lower().startswith("steamlinuxruntime")


def game_dirs(appid: int, *, name: str | None = None, developer: str | None = None, install_dir: str | None = None,
              compat_tool: str | None = None, account_id: str | None = None, home: str | None = None,
              root: str | None = None) -> dict[str, Any]:
    home = home or user_home()
    root = root or steam_root(home)
    libraries = library_folders(root)
    manifest = find_manifest(appid, libraries)
    install = (manifest or {}).get("install_dir") or install_dir or None
    library = (manifest or {}).get("library")
    if library is None and install:
        library = next((lib for lib in libraries if install.startswith(os.path.join(lib, "steamapps") + "/")), None)
    name = name or (manifest or {}).get("name")
    keys = name_keys(name, developer, (manifest or {}).get("installdir"))

    compatdata = next((os.path.join(lib, "steamapps", "compatdata", str(appid)) for lib in ([library] if library else []) + libraries
                       if os.path.isdir(os.path.join(lib, "steamapps", "compatdata", str(appid)))), None)
    prefix = os.path.join(compatdata, "pfx") if compatdata else None
    proton = is_proton_tool(compat_tool) or (not compat_tool and compatdata is not None)
    steamuser = os.path.join(prefix, "drive_c", "users", "steamuser") if prefix else None
    user_dirs = {}
    for key, rel in PREFIX_USER_DIRS:
        path = os.path.join(steamuser, rel) if steamuser else None
        user_dirs[key] = _entry(path, matches=_matching_children(path, keys) if path and os.path.isdir(path) else [])

    acct = account_id or next(iter(account_ids(root, appid)), None)
    userdata = os.path.join(root, "userdata", acct, str(appid)) if acct else None
    shader = next((os.path.join(lib, "steamapps", "shadercache", str(appid)) for lib in ([library] if library else []) + libraries
                   if os.path.isdir(os.path.join(lib, "steamapps", "shadercache", str(appid)))), None)

    xdg = []
    if not proton:
        for base in (os.path.join(home, ".local/share"), os.path.join(home, ".config"),
                     os.path.join(home, ".config/unity3d"), home):
            for path in _matching_children(base, keys, depth=1 if base == home else 2):
                if not os.path.basename(path).startswith(".") or base == home:
                    xdg.append(_entry(path, base=base))
        seen: set[str] = set()
        xdg = [x for x in xdg if not (x["path"] in seen or seen.add(x["path"]))]

    return {
        "appid": appid,
        "name": name,
        "developer": developer,
        "platform": "proton" if proton else "native",
        "compat_tool": compat_tool or None,
        "steam_root": root,
        "library": library,
        "libraries": libraries,
        "install_dir": _entry(install),
        "manifest": manifest["path"] if manifest else None,
        "compatdata": _entry(compatdata),
        "prefix": _entry(prefix),
        "prefix_user_dirs": user_dirs,
        "account_id": acct,
        "userdata": _entry(userdata),
        "cloud_remote": _entry(os.path.join(userdata, "remote") if userdata else None),
        "remotecache": _entry(os.path.join(userdata, "remotecache.vdf") if userdata else None),
        "shader_cache": _entry(shader or (os.path.join(library or root, "steamapps", "shadercache", str(appid)))),
        "xdg": xdg,
        "match_keys": keys,
    }


# ---- saves ----

def parse_remotecache(path: str) -> list[dict[str, Any]]:
    """Files Steam Cloud tracks for an app: [{name, root, size, time}], from userdata/<id>/<appid>/remotecache.vdf."""
    data = vdf.load(path)
    body = next((v for v in data.values() if isinstance(v, dict)), {})
    out = []
    for name, entry in body.items():
        if not isinstance(entry, dict) or "root" not in entry:
            continue
        out.append({
            "name": name,
            "root": int(entry["root"]) if str(entry.get("root")).lstrip("-").isdigit() else entry.get("root"),
            "size": int(entry["size"]) if str(entry.get("size", "")).isdigit() else None,
            "time": int(entry["time"]) if str(entry.get("time", "")).isdigit() else None,
            "syncstate": entry.get("syncstate"),
        })
    return out


def cloud_root_bases(root: int | str, dirs: dict[str, Any], home: str) -> list[str]:
    """Local base dirs a remotecache root id may refer to, most likely first.

    Root ids follow Steamworks' Auto-Cloud roots (0 = the app's userdata remote dir, 1 game install, 2 Windows
    Documents, 3 AppData/Local, 4 AppData/Roaming, 9 Saved Games, 12 AppData/LocalLow, 14-16 Linux home/XDG).
    Linux builds reuse the Windows root id through root overrides, so native titles try the XDG dirs as well.
    Verified on the device for roots 0, 2 and 3 only; the rest come from Steamworks naming.
    """
    def p(entry: Any) -> str | None:
        return entry.get("path") if isinstance(entry, dict) else entry

    user = {k: p(v) for k, v in (dirs.get("prefix_user_dirs") or {}).items()}
    pfx = p(dirs.get("prefix"))
    share, config = os.path.join(home, ".local/share"), os.path.join(home, ".config")
    native = [share, config, home]
    table: dict[int, list[str | None]] = {
        0: [p(dirs.get("cloud_remote"))],
        1: [p(dirs.get("install_dir"))],
        2: [user.get("documents"), *native, os.path.join(home, "Documents")],
        3: [user.get("appdata_local"), *native],
        4: [user.get("appdata_roaming"), config, share],
        5: [p(dirs.get("userdata"))],
        9: [user.get("saved_games"), *native],
        10: [os.path.join(pfx, "drive_c", "ProgramData") if pfx else None],
        12: [user.get("appdata_locallow"), *native],
        14: [home],
        15: [share],
        16: [config],
    }
    try:
        cands = table.get(int(root), native)
    except (TypeError, ValueError):
        cands = native
    return [c for c in dict.fromkeys(cands) if c]


def _file_info(path: str) -> dict[str, Any] | None:
    try:
        st = os.stat(path)
    except OSError:
        return None
    return {"path": path, "size": st.st_size, "mtime": iso(st.st_mtime), "_mtime": st.st_mtime}


def _walk_files(base: str, max_depth: int = SCAN_DEPTH, budget: list[int] | None = None):
    budget = budget if budget is not None else [MAX_SCAN_FILES]
    stack = [(base, 0)]
    while stack and budget[0] > 0:
        d, depth = stack.pop()
        try:
            entries = list(os.scandir(d))
        except OSError:
            continue
        for e in entries:
            if e.is_dir(follow_symlinks=False):
                if depth + 1 < max_depth:
                    stack.append((e.path, depth + 1))
            elif e.is_file(follow_symlinks=False):
                budget[0] -= 1
                yield e
                if budget[0] <= 0:
                    return


def _heuristic_score(path: str, base: str) -> int:
    rel = os.path.relpath(path, base)
    ext = os.path.splitext(path)[1].lower()
    if ext in _NOT_SAVE_EXT or is_sensitive(path):
        return -1
    score = 0
    if _SAVE_DIR.search(rel):
        score += 3
    if ext in _SAVE_EXT:
        score += 2
    if re.search(r"(save|slot|profile|progress|autosave|quicksave)", os.path.basename(path), re.I):
        score += 2
    return score


def game_saves(appid: int, dirs: dict[str, Any], home: str | None = None, limit: int = 40) -> dict[str, Any]:
    """Likely save files for a title: Steam Cloud's own list first, then Auto-Cloud dirs, then heuristics."""
    home = home or user_home()
    found: dict[str, dict[str, Any]] = {}
    notes: list[str] = []

    def add(path: str, found_by: str, rank: int, score: int = 0, **extra: Any) -> None:
        real = os.path.realpath(path)
        if real in found or is_sensitive(path):
            return
        info = _file_info(path)
        if info is None:
            return
        found[real] = {**info, "found_by": found_by, "rank": rank, "score": score, **extra}

    cloud: list[dict[str, Any]] = []
    rc = (dirs.get("remotecache") or {}).get("path")
    if rc and os.path.isfile(rc):
        for item in parse_remotecache(rc):
            bases = cloud_root_bases(item["root"], dirs, home)
            hit = next((os.path.join(b, item["name"]) for b in bases if os.path.isfile(os.path.join(b, item["name"]))), None)
            cloud.append({**item, "local_path": hit, "candidates": None if hit else [os.path.join(b, item["name"]) for b in bases]})
            if hit:
                add(hit, f"steam_cloud remotecache (root {item['root']})", 0, cloud_size=item["size"])
    else:
        notes.append("no Steam Cloud remotecache.vdf for this app and account")

    remote = (dirs.get("cloud_remote") or {}).get("path")
    if remote and os.path.isdir(remote):
        for e in _walk_files(remote):
            add(e.path, "steam_cloud remote dir", 0)

    scan_bases: list[str] = []
    for entry in (dirs.get("prefix_user_dirs") or {}).values():
        scan_bases.extend(entry.get("matches") or [])
    scan_bases.extend(x["path"] for x in dirs.get("xdg") or [] if x.get("exists"))
    if not scan_bases:
        # No dir named after the game: fall back to the whole prefix user dirs (still budgeted).
        scan_bases.extend(e["path"] for e in (dirs.get("prefix_user_dirs") or {}).values() if e.get("exists"))
    install = (dirs.get("install_dir") or {}).get("path")

    budget = [MAX_SCAN_FILES]
    heuristic: list[tuple[str, int]] = []
    for base in dict.fromkeys(scan_bases):
        if os.path.realpath(base) == os.path.realpath(home):
            continue
        for e in _walk_files(base, budget=budget):
            if e.name == "steam_autocloud.vdf":
                d = os.path.dirname(e.path)
                for f in os.scandir(d):
                    if f.is_file(follow_symlinks=False) and f.name != "steam_autocloud.vdf":
                        add(f.path, "steam_autocloud.vdf marker in dir", 1)
                continue
            score = _heuristic_score(e.path, base)
            if score >= 0:
                heuristic.append((e.path, score))
    # Added after the walk so a marker found later in a dir still wins over the heuristic for its files.
    for path, score in heuristic:
        add(path, "heuristic: under a dir named after the game", 2, score)
    if install and os.path.isdir(install):
        for e in _walk_files(install, max_depth=4, budget=budget):
            score = _heuristic_score(e.path, install)
            if score >= 5:
                add(e.path, "heuristic: save-like name in the install dir", 3, score)
    if budget[0] <= 0:
        notes.append(f"heuristic scan stopped after {MAX_SCAN_FILES} files")

    ranked = sorted(found.values(), key=lambda f: (f["rank"], -f["score"], -f["_mtime"]))[:max(1, min(limit, 500))]
    for f in ranked:
        f.pop("_mtime", None)
    return {"appid": appid, "name": dirs.get("name"), "steam_cloud": cloud, "candidates": ranked, "notes": notes}


# ---- file browser ----

def _kind(mode: int) -> str:
    if stat.S_ISLNK(mode):
        return "symlink"
    if stat.S_ISDIR(mode):
        return "dir"
    if stat.S_ISREG(mode):
        return "file"
    return "other"


def fs_stat(path: str, home: str | None = None) -> dict[str, Any]:
    path = expand(path, home)
    check_read(path)
    st = os.lstat(path)
    out: dict[str, Any] = {
        "path": path, "type": _kind(st.st_mode), "size": st.st_size, "mtime": iso(st.st_mtime),
        "mode": oct(stat.S_IMODE(st.st_mode)), "uid": st.st_uid, "gid": st.st_gid,
    }
    try:
        out["owner"] = pwd.getpwuid(st.st_uid).pw_name
    except KeyError:
        pass
    if stat.S_ISLNK(st.st_mode):
        out["target"] = os.readlink(path)
        out["resolved"] = os.path.realpath(path)
    elif stat.S_ISDIR(st.st_mode):
        try:
            out["entries"] = len(os.listdir(path))
        except OSError:
            pass
    return out


def fs_list(path: str, depth: int = 1, glob: str | None = None, home: str | None = None,
            max_entries: int = MAX_LIST_ENTRIES) -> dict[str, Any]:
    path = expand(path, home)
    check_read(path)
    if not isinstance(depth, int) or isinstance(depth, bool) or not 1 <= depth <= MAX_LIST_DEPTH:
        raise ValueError(f"depth must be an integer 1-{MAX_LIST_DEPTH}")
    if not os.path.isdir(path):
        raise FileNotFoundError(f"not a directory: {path}")
    entries: list[dict[str, Any]] = []
    truncated = False
    stack = [(path, 1)]
    while stack:
        d, level = stack.pop(0)
        try:
            items = sorted(os.scandir(d), key=lambda e: e.name)
        except OSError as e:
            entries.append({"path": os.path.relpath(d, path), "error": str(e)})
            continue
        for e in items:
            rel = os.path.relpath(e.path, path)
            try:
                st = e.stat(follow_symlinks=False)
            except OSError:
                continue
            kind = _kind(st.st_mode)
            if kind == "dir" and level < depth:
                stack.append((e.path, level + 1))
            if glob and not fnmatch.fnmatch(rel if "/" in glob else e.name, glob):
                continue
            item: dict[str, Any] = {"path": rel, "type": kind, "size": st.st_size, "mtime": iso(st.st_mtime)}
            if kind == "symlink":
                try:
                    item["target"] = os.readlink(e.path)
                except OSError:
                    pass
            if is_sensitive(e.path):
                item["sensitive"] = True
            entries.append(item)
            if len(entries) >= max_entries:
                truncated = True
                stack.clear()
                break
    return {"path": path, "depth": depth, "glob": glob, "entries": entries, "count": len(entries), "truncated": truncated}


def delete_roots(root: str, libraries: Iterable[str], runtime_dir: str | None) -> list[tuple[str, int]]:
    """(base, min_depth) pairs: a deletable path must lie min_depth or more levels below base."""
    out = []
    for lib in libraries:
        sa = os.path.realpath(os.path.join(lib, "steamapps"))
        out += [(os.path.join(sa, "common"), 2), (os.path.join(sa, "compatdata"), 1), (os.path.join(sa, "shadercache"), 1)]
    out.append((os.path.realpath(os.path.join(root, "userdata")), 2))
    if runtime_dir:
        out.append((os.path.realpath(runtime_dir), 1))
    return out


def deletable(path: str, roots: list[tuple[str, int]]) -> bool:
    # Resolve the parent, not the path itself: deleting a symlink removes the link, never its target.
    real = os.path.join(os.path.realpath(os.path.dirname(path)), os.path.basename(path))
    for base, min_depth in roots:
        if real.startswith(base + "/"):
            parts = os.path.relpath(real, base).split("/")
            if len(parts) < min_depth:
                continue
            if base.endswith("/userdata") and not parts[1].isdigit():
                continue  # only per-app dirs (userdata/<account>/<appid>/...), never config/
            return True
    return False


def fs_delete(path: str, confirm: bool, roots: list[tuple[str, int]], home: str | None = None) -> dict[str, Any]:
    if confirm is not True:
        raise ValueError("fs_delete is destructive: pass confirm=true to delete")
    path = expand(path, home)
    check_read(path)
    if not os.path.lexists(path):
        raise FileNotFoundError(path)
    if not deletable(path, roots):
        raise OutsideRoots(f"refused: {path} is not inside a game dir (steamapps/common/<game>/...), a compatdata or "
                           "shadercache entry, userdata/<account>/<appid> or the plugin runtime dir")
    files, size = 0, 0
    if os.path.isdir(path) and not os.path.islink(path):
        for e in _walk_files(path, max_depth=64, budget=[10 ** 9]):
            check_read(e.path)
            files += 1
            try:
                size += e.stat(follow_symlinks=False).st_size
            except OSError:
                pass
        shutil.rmtree(path)
    else:
        files, size = 1, os.lstat(path).st_size
        os.unlink(path)
    return {"deleted": path, "files": files, "bytes": size}


# ---- remote filesystem (read / write / mkdir / rename) ----

MAX_READ_BYTES = 64 * 1024 * 1024


# Desktop/system config that a loose game-name match could hit (a game called "Fish", "Systemd"...).
_NOT_GAME_XDG = {"systemd", "autostart", "fish", "git", "pulse", "pipewire", "wireplumber", "dconf", "flatpak", "applications",
                 "keyrings", "mime", "environment.d", "containers", "gnupg", "nautilus", "dolphin", "konsole", "kwin",
                 "plasma", "kde", "gtk-3.0", "gtk-4.0", "fontconfig", "fonts", "icons", "themes", "trash", "recently-used.xbel",
                 "steam", "decky", "homebrew", "sddm", "xdg-desktop-portal", "user-dirs.dirs", "mimeapps.list"}


class TooLarge(ValueError):
    pass


def write_roots(root: str, libraries: Iterable[str], runtime_dir: str | None) -> list[tuple[str, int]]:
    """(base, min_depth) pairs a written path must lie under: inside a game's install dir, a Proton prefix,
    userdata/<account>/<appid> or the plugin runtime dir. Never the entries themselves."""
    out = []
    for lib in libraries:
        sa = os.path.realpath(os.path.join(lib, "steamapps"))
        out += [(os.path.join(sa, "common"), 2), (os.path.join(sa, "compatdata"), 2)]
    out.append((os.path.realpath(os.path.join(root, "userdata")), 3))
    if runtime_dir:
        out.append((os.path.realpath(runtime_dir), 1))
    return out


# (write roots, installed-title name keys); None writes anywhere (still behind the guard).
WriteScope = tuple[list[tuple[str, int]], list[str]]


def _device_dirs() -> tuple[str, list[str], str | None]:
    root = steam_root()
    return root, library_folders(root), os.environ.get("DECKY_PLUGIN_RUNTIME_DIR")


def device_delete_roots() -> list[tuple[str, int]]:
    return delete_roots(*_device_dirs())


def device_write_scope() -> WriteScope:
    root, libs, runtime = _device_dirs()
    return write_roots(root, libs, runtime), installed_name_keys(libs)


def installed_name_keys(libraries: Iterable[str]) -> list[str]:
    """Name keys of every installed title (appmanifest name and installdir), for matching XDG game dirs."""
    keys: list[str] = []
    for lib in libraries:
        try:
            names = os.listdir(os.path.join(lib, "steamapps"))
        except OSError:
            continue
        for n in names:
            if not (n.startswith("appmanifest_") and n.endswith(".acf")):
                continue
            try:
                state = vdf.load(os.path.join(lib, "steamapps", n)).get("AppState", {})
            except (OSError, ValueError):
                continue
            keys += name_keys(state.get("name"), state.get("installdir"))
    return list(dict.fromkeys(keys))


def _resolved(path: str, follow: bool) -> str:
    if follow:
        return os.path.realpath(path)
    return os.path.join(os.path.realpath(os.path.dirname(path)), os.path.basename(path))


def writable(path: str, roots: list[tuple[str, int]], home: str, keys: Iterable[str], follow: bool = True) -> bool:
    """Inside write_roots, or inside a ~/.local/share or ~/.config dir named after an installed game (what
    game_dirs resolves for native titles). With follow, a final symlink must point inside as well."""
    real = _resolved(path, follow)
    for base, min_depth in roots:
        if real.startswith(base + "/"):
            parts = os.path.relpath(real, base).split("/")
            if len(parts) < min_depth:
                continue
            if base.endswith("/userdata") and not (parts[0].isdigit() and parts[1].isdigit()):
                continue
            return True
    steam = os.path.realpath(steam_root(home))
    if real == steam or real.startswith(steam + "/"):
        return False
    keys = list(keys)
    for base in (os.path.join(home, ".local/share"), os.path.join(home, ".config")):
        rb = os.path.realpath(base)
        if not real.startswith(rb + "/"):
            continue
        parts = os.path.relpath(real, rb).split("/")
        if parts[0] == "unity3d":
            parts = parts[1:]
            # Company/Product: either level may carry the game's name.
            if len(parts) >= 3 and (name_matches(parts[0], keys) or name_matches(parts[1], keys)):
                return True
            continue
        if (len(parts) >= 2 and not parts[0].startswith(".") and parts[0].lower() not in _NOT_GAME_XDG
                and name_matches(parts[0], keys)):
            return True
    return False


def _check_writable(path: str, scope: WriteScope | None, home: str, follow: bool = True) -> None:
    check_write(path)
    if scope is not None and not writable(path, scope[0], home, scope[1], follow):
        raise OutsideRoots(f"refused: {path} is not inside a game install dir (steamapps/common/<game>/...), a Proton "
                           "prefix (compatdata/<appid>/...), userdata/<account>/<appid>/..., the plugin runtime dir or a "
                           "~/.local/share or ~/.config dir named after an installed game")


def _chown_like(path: str, ref: str) -> None:
    # The server runs as root; files it creates in the user's dirs must stay writable by the game.
    try:
        st = os.stat(ref)
        os.chown(path, st.st_uid, st.st_gid, follow_symlinks=False)
    except OSError:
        pass


def _makedirs_owned(d: str) -> None:
    missing = []
    while not os.path.isdir(d):
        if os.path.lexists(d):
            raise NotADirectoryError(f"not a directory: {d}")
        missing.append(d)
        parent = os.path.dirname(d)
        if parent == d:
            break
        d = parent
    for m in reversed(missing):
        os.mkdir(m, 0o755)
        _chown_like(m, os.path.dirname(m))


def fs_read(path: str, home: str | None = None, max_bytes: int = MAX_READ_BYTES,
            truncate: bool = False) -> tuple[bytes, int]:
    """The file's bytes and size; above max_bytes TooLarge, or with truncate the first max_bytes."""
    path = expand(path, home)
    check_read(path)
    st = os.stat(path)
    if stat.S_ISDIR(st.st_mode):
        raise IsADirectoryError(f"is a directory: {path}")
    if not stat.S_ISREG(st.st_mode):
        raise ValueError(f"not a regular file: {path}")
    if st.st_size > max_bytes and not truncate:
        raise TooLarge(f"{path} is {st.st_size} bytes; the limit is {max_bytes}")
    with open(path, "rb") as f:
        return f.read(max_bytes), st.st_size


def parse_mode(mode: str) -> int:
    if not re.fullmatch(r"0?[0-7]{3,4}", mode or ""):
        raise ValueError(f"mode must be octal like 0644 or 0755, not {mode!r}")
    return int(mode, 8)


def fs_write(path: str, data: bytes, scope: WriteScope | None, home: str | None = None,
             create: bool = True, overwrite: bool = True, mode: int | None = None) -> dict[str, Any]:
    home = home or user_home()
    path = expand(path, home)
    _check_writable(path, scope, home)
    exists = os.path.exists(path)
    if os.path.isdir(path):
        raise IsADirectoryError(f"is a directory: {path}")
    if exists and not overwrite:
        raise FileExistsError(f"exists: {path}")
    if not exists and not create:
        raise FileNotFoundError(path)
    target = os.path.realpath(path)
    parent = os.path.dirname(target)
    _makedirs_owned(parent)
    tmp = os.path.join(parent, f".{os.path.basename(target)}.decky-toolkit-{os.getpid()}.tmp")
    try:
        with open(tmp, "wb") as f:
            f.write(data)
        if exists:
            os.chmod(tmp, stat.S_IMODE(os.stat(target).st_mode) if mode is None else mode)
            _chown_like(tmp, target)
        else:
            os.chmod(tmp, 0o644 if mode is None else mode)
            _chown_like(tmp, parent)
        os.replace(tmp, target)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return {"path": path, "bytes": len(data), "created": not exists}


def fs_mkdir(path: str, scope: WriteScope | None, home: str | None = None,
             parents: bool = False) -> dict[str, Any]:
    home = home or user_home()
    path = expand(path, home)
    _check_writable(path, scope, home)
    if os.path.lexists(path):
        raise FileExistsError(f"exists: {path}")
    parent = os.path.dirname(path)
    if not parents and not os.path.isdir(parent):
        raise FileNotFoundError(f"parent directory does not exist: {parent}")
    _makedirs_owned(path)
    return {"path": path, "created": True}


def fs_rename(src: str, dst: str, scope: WriteScope | None, home: str | None = None,
              overwrite: bool = False) -> dict[str, Any]:
    home = home or user_home()
    src, dst = expand(src, home), expand(dst, home)
    # Renaming a symlink moves the link, never its target.
    _check_writable(src, scope, home, follow=False)
    _check_writable(dst, scope, home, follow=False)
    if not os.path.lexists(src):
        raise FileNotFoundError(src)
    if os.path.lexists(dst) and not overwrite:
        raise FileExistsError(f"exists: {dst}")
    if not os.path.isdir(os.path.dirname(dst)):
        raise FileNotFoundError(f"parent directory does not exist: {os.path.dirname(dst)}")
    if os.path.isdir(src) and not os.path.islink(src):
        for e in _walk_files(src, max_depth=64, budget=[10 ** 6]):
            check_read(e.path)
    os.replace(src, dst)
    return {"from": src, "to": dst}


# ---- logs ----

STEAM_LOGS = ("compat_log.txt", "gameprocess_log.txt", "console_log.txt", "content_log.txt", "cloud_log.txt",
              "shader_log.txt", "streaming_log.txt")


def proton_log(appid: int, lines: int = 200, home: str | None = None, root: str | None = None) -> dict[str, Any]:
    home = home or user_home()
    root = root or steam_root(home)
    path = os.path.join(home, f"steam-{appid}.log")
    out: dict[str, Any] = {"appid": appid}
    if os.path.isfile(path):
        st = os.stat(path)
        out["proton_log"] = {"path": path, "size": st.st_size, "mtime": iso(st.st_mtime), "lines": tail(path, lines).splitlines()}
    else:
        out["proton_log"] = {"path": path, "exists": False,
                             "hint": "set the launch option PROTON_LOG=1 %command% and run the game to create it"}
    needle = re.compile(rf"(?<![0-9]){appid}(?![0-9])")
    steam_logs = []
    for name in STEAM_LOGS:
        p = os.path.join(root, "logs", name)
        if not os.path.isfile(p):
            continue
        # Only the tail is searched: these logs grow for weeks and the recent launches are what matter.
        hits = [l for l in tail(p, 20000).splitlines() if needle.search(l)][-lines:]
        if hits:
            steam_logs.append({"file": p, "mtime": iso(os.path.getmtime(p)), "lines": hits})
    out["steam_logs"] = steam_logs
    out["checked_at"] = iso(time.time())
    return out
