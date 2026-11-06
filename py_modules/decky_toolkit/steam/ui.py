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
          active_plugin: window.DeckyPluginLoader?.deckyState?.publicState?.().activePlugin?.name ?? null,
          running_app: (() => { const id = window.SteamUIStore?.MainRunningAppID;
            return id ? {appid: id, name: window.appStore?.GetAppOverviewByAppID?.(id)?.display_name ?? null} : null; })()};
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
            "quick_access_tab": names.get(tab, tab), "active_plugin": raw.get("active_plugin"),
            "running_app": raw.get("running_app")}


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


TargetEvaluate = Callable[[str, str], Awaitable[Any]]
QUERY_TARGET = "Steam Big Picture Mode"
SIDE_MENU_TARGETS = {"quick_access": "QuickAccess", "main": "MainMenu"}
MAX_LIMIT = 200
MAX_TEXT = 160

# Viewport geometry plus a raw element record. Popup windows (QuickAccess, MainMenu) sit at
# screenX/screenY on the display, in CSS px of the same devicePixelRatio as the Big Picture tab.
_ELEMENT_JS = """const __vp = {w: innerWidth, h: innerHeight, sx: screenX, sy: screenY, sw: screen.width, sh: screen.height,
  dpr: devicePixelRatio};
const __shown = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 &&
  (el.checkVisibility ? el.checkVisibility({opacityProperty: true, visibilityProperty: true}) : true); };
const __el = (el) => { const r = el.getBoundingClientRect();
  return {tag: el.tagName.toLowerCase(), id: el.id || null, classes: [...el.classList],
    text: String(el.innerText ?? el.textContent ?? '').slice(0, 2000), label: el.getAttribute('aria-label'),
    rect: [r.x, r.y, r.width, r.height], shown: __shown(el),
    focused: el.classList.contains('gpfocus') || el === document.activeElement}; };
"""

_QUERY_JS = """(() => { %s
  const sel = %s, needle = %s, limit = %d;
  let els = null;
  if (sel) { try { els = [...document.querySelectorAll(sel)]; } catch (e) { throw new Error('DMCP: invalid selector: ' + e.message); } }
  let exact = new Set();
  if (needle) {
    const n = needle.toLowerCase();
    const own = (el) => (el.getAttribute('aria-label') || '').toLowerCase();
    const hit = (el) => (el.textContent || '').toLowerCase().includes(n) || own(el).includes(n);
    let m = (els ?? [...document.body.querySelectorAll('*')]).filter(hit);
    if (!sel) { const s = new Set(m); m = m.filter(el => ![...el.children].some(c => s.has(c))); }
    exact = new Set(m.filter(el => (el.textContent || '').trim().toLowerCase() === n || own(el) === n));
    els = m;
  }
  els = els || [];
  const ranked = els.map((el, i) => ({el, i, v: __shown(el) ? 0 : 1, x: exact.has(el) ? 0 : 1}))
    .sort((a, b) => a.v - b.v || a.x - b.x || a.i - b.i);
  return {vp: __vp, total: els.length, items: ranked.slice(0, limit).map(r => __el(r.el))};
})()"""

_FOCUS_JS = """(() => { %s
  const gp = [...document.querySelectorAll('.gpfocus')];
  const a = document.activeElement;
  return {vp: __vp, window_focused: document.hasFocus(), gpfocus: gp.map(__el),
          active: a && a !== document.body && a !== document.documentElement ? __el(a) : null};
})()"""


# Quick Access, main menu and toasts are child browser views of the Big Picture window. Their own
# screenX/screenY read 0 after a Steam UI reload, but GetBounds() on the parent's views is reliable
# (QuickAccess: x 1005.5, y 40, 854x681 CSS px on a 1353x761 window, partly off screen).
_VIEW_BOUNDS_JS = """(async () => {
  const pops = [...(window.g_PopupManager?.m_mapPopups?.values?.() || [])];
  const views = pops.flatMap(p => p.m_rgChildBrowserViews || []);
  return (await Promise.all(views.map(v => Promise.resolve().then(() => v.GetBounds()).catch(() => null)))).filter(b => b && b.width > 0);
})()"""


class UiTimeout(ValueError):
    pass


def place_view(vp: dict[str, Any], bounds: list[dict[str, Any]]) -> dict[str, Any]:
    """Give a child view's viewport its offset on the display: the bounds entry of the same size."""
    for b in bounds or []:
        if abs(b.get("width", 0) - vp["w"]) <= 2 and abs(b.get("height", 0) - vp["h"]) <= 2:
            return {**vp, "sx": b.get("x", 0), "sy": b.get("y", 0)}
    return vp


def _denominators(vp: dict[str, Any]) -> tuple[float, float]:
    # The Big Picture tab fills the display (innerWidth 1353 vs screen.width 1352 at dpr 1.42); a popup is
    # smaller and offset, so it maps through the screen size.
    if not vp.get("sx") and not vp.get("sy"):
        return max(vp["w"], vp.get("sw") or 0) or 1, max(vp["h"], vp.get("sh") or 0) or 1
    return vp.get("sw") or vp["w"] or 1, vp.get("sh") or vp["h"] or 1


def shape_element(raw: dict[str, Any], vp: dict[str, Any]) -> dict[str, Any]:
    """Raw element record from the page -> rect in CSS px, centre normalised 0..1 across the display
    (input_mouse x/y) and in display pixels (input_mouse pixels=true), and whether it is on screen.
    The centre is that of the part inside both the tab's viewport and the display, so a partly
    clipped element still gets a point that hits it."""
    x, y, w, h = (float(v or 0) for v in raw.get("rect") or (0, 0, 0, 0))
    sx, sy = float(vp.get("sx") or 0), float(vp.get("sy") or 0)
    dw, dh = _denominators(vp)
    left, right = max(x, 0.0, -sx), min(x + w, float(vp["w"]), dw - sx)
    top, bottom = max(y, 0.0, -sy), min(y + h, float(vp["h"]), dh - sy)
    on_screen = w > 0 and h > 0 and right > left and bottom > top
    if not on_screen:
        left, right, top, bottom = x, x + w, y, y + h
    cx, cy = sx + (left + right) / 2, sy + (top + bottom) / 2
    nx, ny = cx / dw, cy / dh
    dpr = float(vp.get("dpr") or 1)
    text = " ".join(str(raw.get("text") or "").split())
    if len(text) > MAX_TEXT:
        text = text[:MAX_TEXT - 1] + "…"
    out = {
        "tag": raw.get("tag"),
        "id": raw.get("id") or None,
        "classes": list(raw.get("classes") or []),
        "text": text,
        "rect": {"x": round(x, 1), "y": round(y, 1), "width": round(w, 1), "height": round(h, 1)},
        "norm": {"x": round(nx, 4), "y": round(ny, 4)},
        "px": {"x": round(cx * dpr), "y": round(cy * dpr)},
        "visible": bool(raw.get("shown")) and on_screen,
        "focused": bool(raw.get("focused")),
    }
    if raw.get("label"):
        out["label"] = raw["label"]
    return out


def _brief(el: dict[str, Any] | None) -> str:
    if not el:
        return "nothing"
    return f"<{el['tag']}{' #' + el['id'] if el.get('id') else ''}> {el['text'][:60]!r} at {el['norm']}"


class UiInspector:
    def __init__(self, navigator: UiNavigator | None = None, evaluate: TargetEvaluate | None = None,
                 sleep: Callable[[float], Awaitable[Any]] = asyncio.sleep):
        self.nav = navigator or UiNavigator()
        self._evaluate = evaluate or (lambda target, js: cdp.evaluate_in(target, js, timeout=10))
        self._sleep = sleep

    async def _eval(self, target: str, js: str) -> Any:
        try:
            return await self._evaluate(target, js)
        except cdp.CdpError as e:
            msg = str(e)
            if "DMCP: " in msg:
                raise ValueError(msg.split("DMCP: ", 1)[1].splitlines()[0]) from None
            raise

    async def _viewport(self, vp: dict[str, Any]) -> dict[str, Any]:
        if vp.get("sw") and vp["w"] < vp["sw"] - 2:
            try:
                return place_view(vp, await self._eval("SharedJSContext", _VIEW_BOUNDS_JS))
            except cdp.CdpError:
                pass
        return vp

    async def query(self, selector: str | None = None, text: str | None = None, target: str | None = None,
                    limit: int = 20) -> dict[str, Any]:
        if not selector and not text:
            raise ValueError("give selector and/or text")
        limit = max(1, min(int(limit), MAX_LIMIT))
        target = target or QUERY_TARGET
        js = _QUERY_JS % (_ELEMENT_JS, json.dumps(selector or None), json.dumps(text or None), limit)
        raw = await self._eval(target, js)
        if not isinstance(raw, dict):
            raise cdp.CdpError(f"{target} returned no query result")
        vp = await self._viewport(raw["vp"])
        items = [shape_element(r, vp) for r in raw.get("items") or []]
        items.sort(key=lambda e: not e["visible"])
        return {"target": target, "total": raw.get("total", len(items)), "elements": items}

    async def focus(self, target: str | None = None) -> dict[str, Any]:
        state = await self.nav.state()
        # The Quick Access and main menus are separate CEF windows with their own focus tree.
        target = target or SIDE_MENU_TARGETS.get(state.get("side_menu") or "", QUERY_TARGET)
        raw = await self._eval(target, _FOCUS_JS % _ELEMENT_JS)
        if not isinstance(raw, dict):
            raise cdp.CdpError(f"{target} returned no focus data")
        vp = await self._viewport(raw["vp"])
        gp = [shape_element(r, vp) for r in raw.get("gpfocus") or []]
        active = shape_element(raw["active"], vp) if raw.get("active") else None
        element = next((e for e in gp if e["visible"]), gp[0] if gp else active)
        out: dict[str, Any] = {"route": state.get("current"), "side_menu": state.get("side_menu"), "target": target,
                               "window_focused": bool(raw.get("window_focused")), "element": element}
        if len(gp) > 1:
            out["gpfocus"] = gp
        if active and (not element or active["rect"] != element["rect"]):
            out["active_element"] = active
        return out

    async def wait_for(self, selector: str | None = None, text: str | None = None, route: str | None = None,
                       gone: bool = False, timeout: float = 10, interval: float = 0.25,
                       target: str | None = None) -> dict[str, Any]:
        if route is not None and (selector or text):
            raise ValueError("give route, or selector and/or text, not both")
        if route is None and not selector and not text:
            raise ValueError("give selector, text or route")
        timeout = max(0.0, min(float(timeout), 120.0))
        interval = max(0.05, min(float(interval), 5.0))
        want = (route.rstrip("/") or "/") if route is not None else None
        loop = asyncio.get_running_loop()
        start = loop.time()
        last_error: str | None = None
        while True:
            try:
                if want is not None:
                    current = (await self.nav.state()).get("current")
                    if (current == want) != gone:
                        return {"ok": True, "elapsed_s": round(loop.time() - start, 2), "route": current}
                else:
                    res = await self.query(selector, text, target, limit=5)
                    visible = [e for e in res["elements"] if e["visible"]]
                    if bool(visible) != gone:
                        out: dict[str, Any] = {"ok": True, "elapsed_s": round(loop.time() - start, 2)}
                        if visible:
                            out["element"] = visible[0]
                        return out
                last_error = None
            except cdp.CdpError as e:
                last_error = str(e)  # the tab can vanish briefly, e.g. while a plugin reloads
            if loop.time() - start + interval > timeout:
                break
            await self._sleep(interval)
        what = f"route {want}" if want is not None else " ".join(
            f"{k}={v!r}" for k, v in (("selector", selector), ("text", text)) if v)
        try:
            focus = await self.focus()
            where = f"current route {focus['route']}, focus {_brief(focus['element'])}"
        except (cdp.CdpError, ValueError) as e:
            where = f"current route and focus unknown ({e})"
        extra = f"; last error: {last_error}" if last_error else ""
        raise UiTimeout(f"timed out after {timeout:g}s waiting for {what}{' to go' if gone else ''}; {where}{extra}")
