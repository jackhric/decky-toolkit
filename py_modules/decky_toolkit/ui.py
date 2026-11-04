"""Steam UI navigation through @decky/ui's Navigation helpers (window.DFL.Navigation) in SharedJSContext."""
import asyncio
import json
import re
from typing import Any, Awaitable, Callable

from . import cdp

Evaluate = Callable[[str], Awaitable[Any]]
SETTLE_SECONDS = 0.3

# Verified on the device 2026-11-04 by navigating to each and checking the screen. The settings slugs
# are the `identifier`s of Steam's own settings page list; unknown slugs silently show System.
SETTINGS_PAGES = [
    ("system", "System"), ("internet", "Internet"), ("storage", "Storage"), ("bluetooth", "Bluetooth"),
    ("display", "Display"), ("power", "Power"), ("audio", "Audio"), ("keyboard", "Keyboard"),
    ("customization", "Customization"), ("accessibility", "Accessibility"), ("security", "Security"),
    ("notifications", "Notifications"), ("friends", "Friends & Chat"), ("downloads", "Downloads"), ("cloud", "Cloud"),
    ("ingame", "In Game"), ("compatibility", "Compatibility"), ("family", "Family"), ("remoteplay", "Remote Play"),
    ("gamerecording", "Game Recording"), ("home", "Home"), ("library", "Library"), ("store", "Store"),
]
OFFICIAL: list[dict[str, Any]] = [
    {"path": "/library/home", "title": "Home"},
    {"path": "/library", "title": "Library"},
    {"path": "/library/downloads", "title": "Downloads"},
    {"path": "/library/app/{appid}", "title": "Game page", "template": True},
    {"path": "/search", "title": "Search"},
    {"path": "/chat", "title": "Friends & Chat"},
    {"path": "/steamweb", "title": "Store"},
    {"path": "/about", "title": "About"},
    {"path": "/accessibility", "title": "Accessibility (quick settings)"},
    {"path": "/settings", "title": "Settings"},
    *({"path": f"/settings/{slug}", "title": f"Settings: {title}"} for slug, title in SETTINGS_PAGES),
    {"path": "/settings/controller", "title": "Settings: Controller (first Steam Input controller)"},
    {"path": "/settings/controller/{type}/{index}", "title": "Settings: Controller (one controller)", "template": True},
    {"path": "/decky/settings", "title": "Decky settings"},
    {"path": "/decky/settings/general", "title": "Decky settings: General"},
    {"path": "/decky/settings/plugins", "title": "Decky settings: Plugins"},
    {"path": "/decky/settings/developer", "title": "Decky settings: Developer"},
    {"path": "/decky/settings/testing", "title": "Decky settings: Testing"},
    {"path": "/decky/store", "title": "Decky plugin store"},
]
ACTIONS = ("back", "quick_access", "main_menu", "close_menus", "plugin", "app")
# @decky/ui QuickAccessTab enum (DFL.QuickAccessTab); the JS side re-reads it from DFL when present.
QUICK_ACCESS_TABS = {"notifications": 0, "remoteplaytogethercontrols": 1, "voicechat": 2, "friends": 3,
                     "settings": 4, "perf": 5, "help": 6, "soundtrack": 7, "vrbatteries": 8, "decky": 999}
SIDE_MENUS = {0: "none", 1: "main", 2: "quick_access"}
DECKY_OWNED = ("/decky/",)

_STATE_JS = """(() => {
  const win = window.SteamUIStore?.WindowStore?.GamepadUIMainWindowInstance;
  const menu = win?.MenuStore;
  return {current: win?.LocationPathName ?? null, side_menu: menu?.GetOpenSideMenu?.() ?? null,
          quick_access_tab: menu?.GetQuickAccessTab?.() ?? null,
          active_plugin: window.DeckyPluginLoader?.deckyState?.publicState?.().activePlugin?.name ?? null};
})()"""

_ROUTES_JS = """(() => {
  const rh = window.DeckyPluginLoader?.routerHook;
  const steam = [];
  const walk = (x, d) => { if (!x || d > 4) return; if (Array.isArray(x)) return x.forEach(y => walk(y, d + 1));
    const p = x.props; if (p && p.path) (Array.isArray(p.path) ? p.path : String(p.path).split('|')).forEach(s => steam.push(s)); };
  walk(rh?.routes, 0);
  const rs = rh?.routerState;
  const keys = (m) => m instanceof Map ? [...m.keys()] : Object.keys(m || {});
  return {steam, decky: keys(rs?._routes), patches: keys(rs?._routePatches),
          plugins: (window.DeckyPluginLoader?.plugins || []).map(p => p.name),
          tabs: Object.keys(window.DFL?.QuickAccessTab || {}).filter(k => isNaN(+k)), state: %s};
})()""" % _STATE_JS


def _nav_js(body: str) -> str:
    # Navigation is @decky/ui's wrapper: it resolves SteamUIStore.GetFocusedWindowInstance() (falling back to
    # the main gamepad window) and calls Navigate/NavigateBack there and OpenQuickAccessMenu/OpenMainMenu/
    # CloseSideMenus on its MenuStore.
    return ("(async () => { const N = window.DFL?.Navigation; if (!N || !N.Navigate) throw new Error('DMCP: "
            "@decky/ui Navigation (window.DFL.Navigation) is not available'); " + body + "; return 1; })()")


def _match(pattern: str, path: str) -> bool:
    parts = []
    for seg in pattern.strip("/").split("/"):
        if seg.startswith(":"):
            parts.append("(?:/[^/]+)?" if seg.endswith("?") else "/[^/]+")
        elif seg:
            parts.append("/" + re.escape(seg))
    return re.fullmatch("".join(parts) + "/?", path) is not None


def _template_match(template: str, path: str) -> bool:
    return re.fullmatch(re.sub(r"\\\{[a-z]+\\\}", "[^/]+", re.escape(template)), path) is not None


def owner_of(path: str, plugins: list[str]) -> str:
    if path.startswith(DECKY_OWNED):
        return "Decky Loader"
    slug = path.lower()
    for name in plugins:
        for variant in {name.lower(), re.sub(r"[^a-z0-9]+", "-", name.lower()), re.sub(r"[^a-z0-9]+", "", name.lower())}:
            if variant and variant in slug:
                return name
    return "unknown"


def known_path(path: str, steam_routes: list[str], decky_routes: list[str]) -> bool:
    for r in OFFICIAL:
        if (_template_match(r["path"], path) if r.get("template") else r["path"] == path):
            return True
    if path.startswith("/settings/"):
        return False
    return any(_match(p, path) for p in [*steam_routes, *decky_routes] if p not in ("/", "/index.html", "/sp.html"))


def parse_request(path: Any = None, action: Any = None, tab: Any = None, plugin: Any = None,
                  appid: Any = None) -> dict[str, Any]:
    """Validate a navigate request into {"path": str} or {"action": str, ...}."""
    if (path is None) == (action is None):
        raise ValueError(f"give exactly one of path or action ({', '.join(ACTIONS)})")
    if path is not None:
        if not isinstance(path, str) or not path.startswith("/") or len(path) > 512 or any(c in path for c in "\n\r\\\0"):
            raise ValueError("path must be an absolute route such as /library/home")
        if any(v is not None for v in (tab, plugin, appid)):
            raise ValueError("tab, plugin and appid go with an action, not a path")
        return {"path": path.rstrip("/") or "/"}
    if action not in ACTIONS:
        raise ValueError(f"unknown action {action!r}; known: {', '.join(ACTIONS)}")
    req: dict[str, Any] = {"action": action}
    if action == "quick_access":
        if tab is not None:
            if not isinstance(tab, str) or tab.lower() not in QUICK_ACCESS_TABS:
                raise ValueError(f"unknown quick access tab {tab!r}; known: {', '.join(QUICK_ACCESS_TABS)}")
            req["tab"] = tab.lower()
    elif tab is not None:
        raise ValueError("tab only goes with action quick_access")
    if action == "plugin":
        if not isinstance(plugin, str) or not plugin.strip():
            raise ValueError("action plugin needs plugin: the Decky plugin name")
        req["plugin"] = plugin.strip()
    elif plugin is not None:
        raise ValueError("plugin only goes with action plugin")
    if action == "app":
        if isinstance(appid, str) and appid.isdigit():
            appid = int(appid)
        if not isinstance(appid, int) or isinstance(appid, bool) or appid <= 0:
            raise ValueError("action app needs appid: a positive integer")
        req["appid"] = appid
    elif appid is not None:
        raise ValueError("appid only goes with action app")
    return req


def _state(raw: dict[str, Any] | None) -> dict[str, Any]:
    raw = raw or {}
    tab = raw.get("quick_access_tab")
    names = {v: k for k, v in QUICK_ACCESS_TABS.items()}
    return {"current": raw.get("current"), "side_menu": SIDE_MENUS.get(raw.get("side_menu"), raw.get("side_menu")),
            "quick_access_tab": names.get(tab, tab), "active_plugin": raw.get("active_plugin")}


class UiNavigator:
    def __init__(self, evaluate: Evaluate | None = None, settle: float = SETTLE_SECONDS):
        self._evaluate = evaluate or (lambda js: cdp.evaluate_in(None, js, timeout=10))
        self.settle = settle

    async def _eval(self, js: str) -> Any:
        try:
            return await self._evaluate(js)
        except cdp.CdpError as e:
            msg = str(e)
            if "DMCP: " in msg:
                raise ValueError(msg.split("DMCP: ", 1)[1].splitlines()[0]) from None
            raise

    async def _raw_routes(self) -> dict[str, Any]:
        raw = await self._eval(_ROUTES_JS)
        if not isinstance(raw, dict):
            raise cdp.CdpError("Steam UI returned no route data")
        return raw

    async def routes(self) -> dict[str, Any]:
        raw = await self._raw_routes()
        plugins = raw.get("plugins") or []
        titles = {r["path"]: r["title"] for r in OFFICIAL}
        decky = [{"plugin": owner_of(p, plugins), "path": p,
                  "title": titles.get(p) or p.strip("/").replace("/", " ").replace("-", " ").title() or p}
                 for p in raw.get("decky") or []]
        patched = [{"plugin": owner_of(p, plugins), "path": p} for p in raw.get("patches") or []]
        tabs = [t.lower() for t in raw.get("tabs") or []] or list(QUICK_ACCESS_TABS)
        return {**_state(raw.get("state")), "official": OFFICIAL, "plugins": decky, "patched": patched,
                "decky_plugins": plugins, "quick_access_tabs": tabs, "steam_routes": raw.get("steam") or []}

    async def state(self) -> dict[str, Any]:
        return _state(await self._eval(_STATE_JS))

    async def navigate(self, **kwargs: Any) -> dict[str, Any]:
        req = parse_request(**kwargs)
        if "path" in req:
            path = req["path"]
            raw = await self._raw_routes()
            if not known_path(path, raw.get("steam") or [], raw.get("decky") or []):
                known = [r["path"] for r in OFFICIAL] + list(raw.get("decky") or [])
                raise ValueError(f"unknown route {path!r}; known: {', '.join(known)}")
            if path == "/settings/controller":
                body = ("const cs = window.ControllerStore; const c = cs?.GetControllersSorted?.(true)?.[0]; "
                        "if (!c) throw new Error('DMCP: Steam Input lists no controller'); "
                        "N.Navigate('/settings/controller/' + cs.GetControllerTypeString(c.eControllerType) + '/' + "
                        "c.nControllerIndex); N.CloseSideMenus()")
            else:
                # CloseSideMenus after Navigate, as @decky/ui recommends (desktop BPM races otherwise).
                body = f"N.Navigate({json.dumps(path)}); N.CloseSideMenus()"
        else:
            action = req["action"]
            if action == "back":
                body = "N.NavigateBack()"
            elif action == "main_menu":
                body = "N.OpenMainMenu()"
            elif action == "close_menus":
                body = "N.CloseSideMenus()"
            elif action == "quick_access":
                tab = req.get("tab")
                if tab is None:
                    body = "N.OpenQuickAccessMenu()"
                else:
                    body = (f"const T = window.DFL?.QuickAccessTab || {{}}; "
                            f"const key = Object.keys(T).find(k => k.toLowerCase() === {json.dumps(tab)}); "
                            f"N.OpenQuickAccessMenu(key !== undefined ? T[key] : {QUICK_ACCESS_TABS[tab]})")
            elif action == "plugin":
                body = (f"const L = window.DeckyPluginLoader; const want = {json.dumps(req['plugin'])}.toLowerCase(); "
                        "const p = (L?.plugins || []).find(x => x.name.toLowerCase() === want); "
                        "if (!p) throw new Error('DMCP: unknown Decky plugin ' + JSON.stringify(want) + '; loaded: ' + "
                        "(L?.plugins || []).map(x => x.name).join(', ')); "
                        "L.deckyState.setActivePlugin(p.name); "
                        "N.OpenQuickAccessMenu(window.DFL?.QuickAccessTab?.Decky ?? 999)")
            else:
                appid = req["appid"]
                body = (f"const ov = window.appStore?.GetAppOverviewByAppID?.({appid}); "
                        f"if (window.appStore && !ov) throw new Error('DMCP: no app {appid} in the Steam library'); "
                        f"N.Navigate('/library/app/{appid}'); N.CloseSideMenus()")
        await self._eval(_nav_js(body))
        await asyncio.sleep(self.settle)
        return {"ok": True, **await self.state()}
