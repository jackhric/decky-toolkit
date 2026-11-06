"""Steam UI navigation tools."""
import asyncio
import base64
import json
from typing import Any

from ..media.capture import ScreenCapturer
from ..steam import cdp
from ..input.activity import InputActivity
from ..steam.ui import ACTIONS, QUERY_TARGET, QUICK_ACCESS_TABS, UiInspector
from . import ToolRegistry

CAPTURE_SETTLE_SECONDS = 0.7
AT_DEVICE_SECONDS = 60


class Orientation:
    """Where the device is: the Steam UI state plus whether someone is using it by hand."""

    def __init__(self, inspector: UiInspector, activity: InputActivity):
        self.inspector, self.activity = inspector, activity

    async def __call__(self) -> dict[str, Any]:
        state = await self.inspector.snapshot()
        last = self.activity.snapshot()["last"]
        state["someone_at_device"] = bool(last and last["seconds_ago"] <= AT_DEVICE_SECONDS)
        return state

    @staticmethod
    def line(state: dict[str, Any]) -> str:
        """One line for results that are easy to misread without it (screenshots)."""
        if "error" in state:
            return state["error"]
        app = state.get("running_app")
        parts = [f"route {state.get('current')}", f"menu {state.get('side_menu')}",
                 f"game {app['name'] or app['appid']}" if app else "no game running"]
        if state.get("dialog"):
            parts.append(f"dialog {state['dialog'].get('title') or 'open'}")
        if state.get("keyboard"):
            parts.append("on-screen keyboard open")
        if state.get("focus"):
            parts.append(f"focus {state['focus']['text']!r}")
        if state.get("someone_at_device"):
            parts.append("someone is using the device")
        return " · ".join(parts)

    async def safe(self) -> dict[str, Any]:
        try:
            return await self()
        except (cdp.CdpError, OSError, asyncio.TimeoutError, ValueError) as e:
            return {"error": f"Steam UI state unavailable: {e}"}


def register(reg: ToolRegistry, inspector: UiInspector, capturer: ScreenCapturer, orient: Orientation) -> None:
    nav = inspector.nav

    @reg.add(
        "ui_routes",
        "Pages the Steam UI can show: official (verified Steam and Decky routes; template entries take "
        "{appid} etc.), plugins (routes Decky plugins registered, with owner), patched routes, the Decky plugin "
        "names for ui_navigate(action='plugin'), quick_access_tabs, steam_routes (Steam's raw route table) and "
        "the current page/menu state.",
    )
    async def ui_routes() -> dict[str, Any]:
        return await nav.routes()

    @reg.add(
        "ui_state",
        "Call first, before navigating, sending input, launching anything or judging a screenshot: screenshots "
        "show pixels, not state. Returns {current (route), side_menu (none|main|quick_access), quick_access_tab, "
        "active_plugin (Decky panel), running_app ({appid, name} of the game in front, or null: then keys and "
        "buttons go to the game), focus ({text, tag, target} of the focused element; tag input = a text field), "
        "dialog ({title, text, buttons} of an open Steam dialog, or null), keyboard (on-screen keyboard showing), "
        f"someone_at_device (physical input in the last {AT_DEVICE_SECONDS} s: leave the UI alone)}}.",
    )
    async def ui_state() -> dict[str, Any]:
        return await orient()

    @reg.add(
        "ui_navigate",
        "Navigate the Steam UI. Give path (e.g. /library/home, /settings/display, /settings/controller, "
        "/decky/settings/plugins, a plugin route; see ui_routes) or action: back, quick_access (tab: "
        f"{', '.join(QUICK_ACCESS_TABS)}), main_menu, close_menus, plugin (plugin: Decky plugin name, opens its "
        "Quick Access panel), app (appid: game page). Returns {ok, current, side_menu, quick_access_tab, "
        "active_plugin}. capture=true appends a screen frame after 0.7 s.",
        {"properties": {
            "path": {"type": "string"},
            "action": {"type": "string", "enum": list(ACTIONS)},
            "tab": {"type": "string"},
            "plugin": {"type": "string"},
            "appid": {"type": "integer"},
            "capture": {"type": "boolean", "default": False},
        }},
    )
    async def ui_navigate(path: str | None = None, action: str | None = None, tab: str | None = None,
                          plugin: str | None = None, appid: int | None = None, capture: bool = False) -> Any:
        result = await nav.navigate(path=path, action=action, tab=tab, plugin=plugin, appid=appid)
        if not capture:
            return result
        await asyncio.sleep(max(0.0, CAPTURE_SETTLE_SECONDS - nav.settle))
        frame = await capturer.grab()
        return [{"type": "text", "text": json.dumps(result, indent=2)},
                {"type": "image", "data": base64.b64encode(frame).decode(), "mimeType": "image/jpeg"}]

    element_doc = ("Elements are {tag, id, classes, text, label?, rect (CSS px in the tab), norm {x, y} (centre, 0..1 "
                   "across the display: pass to input_mouse x/y), px {x, y} (centre in display pixels), visible, focused "
                   "(Steam's gamepad focus class gpfocus, or document.activeElement)}.")

    @reg.add(
        "ui_query",
        "Find elements in a Steam UI tab by CSS selector and/or text (case-insensitive substring of the text or "
        "aria-label; with text alone the innermost matching elements). Visible, then exact text matches come first. "
        f"target: CEF tab title or prefix (default '{QUERY_TARGET}'; 'QuickAccess' and 'MainMenu' are the side "
        f"menus). {element_doc} Returns {{target, total, elements}}.",
        {"properties": {
            "selector": {"type": "string"},
            "text": {"type": "string"},
            "target": {"type": "string", "default": QUERY_TARGET},
            "limit": {"type": "integer", "default": 20, "minimum": 1, "maximum": 200},
        }},
    )
    async def ui_query(selector: str | None = None, text: str | None = None, target: str | None = None,
                       limit: int = 20) -> dict[str, Any]:
        return await inspector.query(selector, text, target, limit)

    @reg.add(
        "ui_focus",
        "The element that has gamepad focus (Steam marks it with the gpfocus class) plus the current route. "
        "Without target it looks in the Quick Access or main menu window when one is open, else in "
        f"'{QUERY_TARGET}'. Returns {{route, side_menu, target, window_focused, element, gpfocus? (if several), "
        f"active_element? (document.activeElement when it differs)}}. {element_doc}",
        {"properties": {"target": {"type": "string"}}},
    )
    async def ui_focus(target: str | None = None) -> dict[str, Any]:
        return await inspector.focus(target)

    @reg.add(
        "ui_wait",
        "Poll until an element matching selector and/or text is visible (gone=true: until none is), or until the "
        "current route equals route (gone=true: differs). Use after ui_navigate, plugin_reload or input instead of "
        "sleeping. Returns {ok, elapsed_s, element | route}; on timeout an error with the current route and focus.",
        {"properties": {
            "selector": {"type": "string"},
            "text": {"type": "string"},
            "route": {"type": "string", "description": "e.g. /settings/system"},
            "gone": {"type": "boolean", "default": False},
            "timeout": {"type": "number", "default": 10, "maximum": 120},
            "interval": {"type": "number", "default": 0.25},
            "target": {"type": "string", "default": QUERY_TARGET},
        }},
    )
    async def ui_wait(selector: str | None = None, text: str | None = None, route: str | None = None,
                          gone: bool = False, timeout: float = 10, interval: float = 0.25,
                          target: str | None = None) -> dict[str, Any]:
        return await inspector.wait_for(selector, text, route, gone, timeout, interval, target)
