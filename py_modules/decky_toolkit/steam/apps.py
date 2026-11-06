"""Steam library, running apps and launch/terminate through the Steam client's JS (SharedJSContext).

API names verified on the device (Steam client 1792618285, 2026-11-04): `appStore.allApps` /
`appStore.GetAppOverviewByAppID`, `SteamClient.Apps.RegisterForAppDetails` (strInstallFolder, strCompatToolName,
strDeveloperName ...), `SteamClient.InstallFolder.GetInstallFolders`, `SteamUIStore.RunningApps`,
`SteamClient.Apps.RunGame(gameid, "", -1, 100)`, `SteamClient.Apps.TerminateApp(gameid, false)`.
There is no `SteamClient.Apps.GetRunningApps` or `GetAvailableCompatTools` on this build.
"""
import asyncio
import json
import os
from typing import Any, Awaitable, Callable

from . import cdp
from ..games import files as games

Evaluate = Callable[[str], Awaitable[Any]]
SHORTCUT_TYPE = 1073741824
APP_TYPES = {1: "game", 2: "application", 4: "tool", 8: "demo", 32: "dlc", 2048: "video", 8192: "music",
             65536: "beta", SHORTCUT_TYPE: "shortcut"}

# Steam's appDetailsStore cache only fills while something is registered for an app, so register and take the
# first callback. It can fire inside RegisterForAppDetails before the handle exists, hence the deferred unregister.
_HELPERS = r"""
const __details = (id, ms = 3000) => new Promise((resolve) => {
  let h = null, done = false;
  const fin = (d) => { if (done) return; done = true; setTimeout(() => { try { h && h.unregister(); } catch (e) {} }, 0); resolve(d || null); };
  setTimeout(() => fin(null), ms);
  try { h = SteamClient.Apps.RegisterForAppDetails(id, fin); } catch (e) { fin(null); }
});
const __num = (v) => v == null ? null : Number(v);
const __row = (a, d, folders) => ({
  appid: a.appid, name: a.display_name, app_type: a.app_type, gameid: String(a.m_gameid || a.appid),
  installed: !!a.local_per_client_data?.installed,
  installed_elsewhere: (a.per_client_data || []).filter(c => c.clientid !== "0" && c.installed).map(c => c.client_name),
  size_on_disk: __num(d?.lDiskUsageBytes ?? a.size_on_disk), last_played: a.rt_last_time_played || 0,
  playtime_minutes: a.minutes_playtime_forever ?? null,
  install_dir: d?.strInstallFolder || null, library: folders[a.appid] ?? null,
  compat_tool: d?.strCompatToolName ?? null, compat_tool_display: d?.strCompatToolDisplayName ?? null,
  developer: d?.strDeveloperName ?? null, platforms: d?.vecPlatforms ?? null,
  shortcut_exe: d?.strShortcutExe ?? null, shortcut_start_dir: d?.strShortcutStartDir ?? null,
  launch_options: d?.strLaunchOptions ?? null, build_id: d?.nBuildID ?? null,
  cloud: d ? {enabled: !!d.bCloudEnabledForApp, available: !!d.bCloudAvailable, used: d.strCloudBytesUsed || null} : null,
});
const __folders = async () => {
  const map = {};
  for (const f of await SteamClient.InstallFolder.GetInstallFolders()) for (const v of f.vecApps || []) map[v.nAppID] = f.strFolderPath;
  return map;
};
const __running = () => (SteamUIStore.RunningApps || []).map(r => ({appid: r.appid, name: r.display_name}));
const __user = () => window.App?.m_CurrentUser?.strSteamID ?? null;
"""

_LIST_JS = r"""
(async () => {
  const folders = await __folders();
  const running = new Set(__running().map(r => r.appid));
  const apps = appStore.allApps.filter(a => (!__INSTALLED__ || a.local_per_client_data?.installed)
      && (__TOOLS__ || a.app_type !== 4)
      && (!__QUERY__ || (a.display_name || '').toLowerCase().includes(__QUERY__) || String(a.appid) === __QUERY__));
  const details = await Promise.all(apps.map(a => a.local_per_client_data?.installed ? __details(a.appid) : null));
  return JSON.stringify({steamid: __user(), apps: apps.map((a, i) => ({...__row(a, details[i], folders), running: running.has(a.appid)}))});
})()
"""

_ONE_JS = r"""
(async () => {
  const a = appStore.GetAppOverviewByAppID(__APPID__);
  if (!a) return JSON.stringify(null);
  const d = await __details(__APPID__);
  const row = __row(a, d, await __folders());
  row.running = __running().some(r => r.appid === __APPID__);
  return JSON.stringify({steamid: __user(), app: row});
})()
"""

_RUNNING_JS = r"""
JSON.stringify({running: __running(), main: SteamUIStore.MainRunningAppID ?? null})
"""


# Each evaluate shares the context's global scope, so the helpers live inside a function, not at top level.
def _with_helpers(body: str) -> str:
    return "(() => {" + _HELPERS + "return " + body.strip() + ";\n})()"


_LIST_JS, _ONE_JS, _RUNNING_JS = map(_with_helpers, (_LIST_JS, _ONE_JS, _RUNNING_JS))

_ACTIONS_JS = r"""
(async () => JSON.stringify(await SteamClient.Apps.GetActiveGameActions?.() ?? null))()
"""


def type_name(app_type: int | None) -> str:
    return APP_TYPES.get(app_type or 0, str(app_type))


def _check_appid(appid: Any) -> int:
    if isinstance(appid, bool) or not isinstance(appid, int) or appid <= 0 or appid >= 2 ** 32:
        raise ValueError("appid must be a positive integer")
    return appid


def _iso(ts: Any) -> str | None:
    return games.iso(ts) if ts else None


def _proc_pids(appid: int) -> list[dict[str, Any]]:
    """Processes of a running Steam app: the `reaper SteamLaunch AppId=<id>` process and its descendants."""
    children: dict[int, list[int]] = {}
    cmd: dict[int, str] = {}
    for d in os.listdir("/proc"):
        if not d.isdigit():
            continue
        try:
            with open(f"/proc/{d}/stat") as f:
                ppid = int(f.read().rsplit(")", 1)[1].split()[1])
            with open(f"/proc/{d}/cmdline", "rb") as f:
                cmd[int(d)] = f.read().replace(b"\0", b" ").decode(errors="replace").strip()
        except (OSError, ValueError, IndexError):
            continue
        children.setdefault(ppid, []).append(int(d))
    roots = [p for p, c in cmd.items() if "SteamLaunch" in c and f"AppId={appid} " in c + " "]
    out, stack = [], list(roots)
    while stack:
        pid = stack.pop()
        out.append({"pid": pid, "cmdline": cmd.get(pid, "")[:300], "reaper": pid in roots})
        stack.extend(children.get(pid, []))
    return out


class Apps:
    def __init__(self, evaluate: Evaluate | None = None) -> None:
        self._eval = evaluate or (lambda js: cdp.evaluate_in(None, js, timeout=20))

    async def _json(self, js: str) -> Any:
        raw = await self._eval(js)
        return json.loads(raw) if isinstance(raw, str) else raw

    async def list(self, installed_only: bool = True, query: str | None = None, include_tools: bool = False) -> dict[str, Any]:
        js = (_LIST_JS.replace("__INSTALLED__", "true" if installed_only else "false")
              .replace("__TOOLS__", "true" if include_tools else "false")
              .replace("__QUERY__", json.dumps((query or "").strip().lower())))
        data = await self._json(js)
        apps = [self._shape(a) for a in data["apps"]]
        apps.sort(key=lambda a: (a["name"] or "").lower())
        return {"count": len(apps), "apps": apps}

    def _shape(self, a: dict[str, Any]) -> dict[str, Any]:
        out = {k: a.get(k) for k in ("appid", "name", "installed", "running", "install_dir", "compat_tool",
                                    "compat_tool_display", "size_on_disk", "library")}
        for k in ("compat_tool", "compat_tool_display", "install_dir"):
            out[k] = out[k] or None
        out["type"] = type_name(a.get("app_type"))
        out["last_played"] = _iso(a.get("last_played"))
        if a.get("installed_elsewhere"):
            out["installed_elsewhere"] = a["installed_elsewhere"]
        if out["type"] == "shortcut":
            out["shortcut_exe"] = a.get("shortcut_exe")
            out["install_dir"] = out["install_dir"] or (a.get("shortcut_start_dir") or "").strip('"') or None
        return out

    async def raw(self, appid: int) -> tuple[dict[str, Any], str | None]:
        _check_appid(appid)
        data = await self._json(_ONE_JS.replace("__APPID__", str(appid)))
        if not data:
            raise FileNotFoundError(f"app {appid} is not in this Steam library")
        return data["app"], games.account_id_from_steamid(data.get("steamid"))

    async def dirs(self, appid: int) -> dict[str, Any]:
        app, acct = await self.raw(appid)
        return await asyncio.to_thread(self._dirs, app, acct)

    @staticmethod
    def _dirs(app: dict[str, Any], acct: str | None) -> dict[str, Any]:
        install = app.get("install_dir")
        if not install and app.get("shortcut_start_dir"):
            install = app["shortcut_start_dir"].strip('"') or None
        return games.game_dirs(app["appid"], name=app.get("name"), developer=app.get("developer"), install_dir=install,
                               compat_tool=app.get("compat_tool"), account_id=acct)

    async def info(self, appid: int) -> dict[str, Any]:
        app, acct = await self.raw(appid)
        dirs = await asyncio.to_thread(self._dirs, app, acct)
        out = {**self._shape(app), **{k: app.get(k) for k in ("gameid", "developer", "platforms", "playtime_minutes",
                                                              "launch_options", "build_id", "cloud", "shortcut_exe",
                                                              "shortcut_start_dir")}}
        if app.get("running"):
            out["processes"] = await asyncio.to_thread(_proc_pids, appid)
        out["dirs"] = dirs
        return out

    async def saves(self, appid: int, limit: int = 40) -> dict[str, Any]:
        dirs = await self.dirs(appid)
        return await asyncio.to_thread(games.game_saves, appid, dirs, None, limit)

    async def running(self) -> dict[str, Any]:
        data = await self._json(_RUNNING_JS)
        apps = []
        for r in data["running"]:
            procs = await asyncio.to_thread(_proc_pids, r["appid"])
            reaper = next((p["pid"] for p in procs if p["reaper"]), None)
            apps.append({**r, "pid": reaper, "processes": procs})
        return {"running": apps, "main_appid": data.get("main")}

    async def _gameid(self, appid: int) -> tuple[dict[str, Any], str]:
        app, _ = await self.raw(appid)
        return app, app.get("gameid") or str(appid)

    async def _is_running(self, appid: int) -> bool:
        data = await self._json(_RUNNING_JS)
        return any(r["appid"] == appid for r in data["running"])

    async def launch(self, appid: int, wait: float = 15) -> dict[str, Any]:
        app, gameid = await self._gameid(appid)
        if not app.get("installed"):
            raise ValueError(f"{app.get('name')} ({appid}) is not installed")
        if app.get("running"):
            return {"appid": appid, "name": app.get("name"), "launched": False, "running": True, "note": "already running"}
        await self._eval(f"SteamClient.Apps.RunGame({json.dumps(gameid)}, '', -1, 100), true")
        running = await self._wait_running(appid, True, wait)
        out: dict[str, Any] = {"appid": appid, "name": app.get("name"), "launched": True, "running": running}
        if not running:
            out["game_actions"] = await self._json(_ACTIONS_JS)
            out["note"] = ("not running yet: Steam may be showing a dialog (e.g. the account plays elsewhere, an EULA, "
                           "an update); check screen_capture")
        return out

    async def terminate(self, appid: int, confirm: bool = False, wait: float = 15) -> dict[str, Any]:
        if confirm is not True:
            raise ValueError("app_terminate closes the game without saving: pass confirm=true")
        app, gameid = await self._gameid(appid)
        if not app.get("running"):
            return {"appid": appid, "name": app.get("name"), "terminated": False, "running": False, "note": "not running"}
        await self._eval(f"SteamClient.Apps.TerminateApp({json.dumps(gameid)}, false), true")
        running = await self._wait_running(appid, False, wait)
        return {"appid": appid, "name": app.get("name"), "terminated": not running, "running": running}

    async def _wait_running(self, appid: int, want: bool, wait: float) -> bool:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + max(0.0, min(float(wait), 60.0))
        while True:
            state = await self._is_running(appid)
            if state == want or loop.time() >= deadline:
                return state
            await asyncio.sleep(0.5)
