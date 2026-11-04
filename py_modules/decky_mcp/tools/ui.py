"""Steam UI navigation tools."""
import asyncio
import base64
import json
from typing import Any

from ..capture import CaptureUnavailable, ScreenCapturer
from ..ui import ACTIONS, QUICK_ACCESS_TABS, UiNavigator
from . import ToolRegistry

CAPTURE_SETTLE_SECONDS = 0.7


def register(reg: ToolRegistry, navigator: UiNavigator | None, capturer: ScreenCapturer | None) -> None:
    nav = navigator or UiNavigator()

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
        if capturer is None:
            raise CaptureUnavailable("screen capture not configured")
        await asyncio.sleep(max(0.0, CAPTURE_SETTLE_SECONDS - nav.settle))
        frame = await capturer.grab()
        return [{"type": "text", "text": json.dumps(result, indent=2)},
                {"type": "image", "data": base64.b64encode(frame).decode(), "mimeType": "image/jpeg"}]
