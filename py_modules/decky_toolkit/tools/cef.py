"""Tools that drive the Steam client through its CEF DevTools port."""
import json
from typing import Any

from ..steam import cdp
from . import ToolRegistry


async def toast(title: str, body: str, duration_ms: int = 5000) -> Any:
    js = ("(async () => { const t = window.DeckyPluginLoader?.toaster; if (!t) throw new Error('DeckyPluginLoader.toaster missing');"
          f" t.toast({{ title: {json.dumps(title)}, body: {json.dumps(body)}, duration: {int(duration_ms)} }}); return 'ok'; }})()")
    return await cdp.evaluate_in(None, js)


def register(reg: ToolRegistry) -> None:
    @reg.add("cef_targets", "List Steam CEF DevTools targets (tabs) exposed on localhost:8080.")
    async def cef_targets() -> list[dict[str, Any]]:
        return [{k: t.get(k) for k in ("id", "type", "title", "url")} for t in await cdp.list_targets()]

    @reg.add(
        "cef_evaluate",
        "Evaluate a JavaScript expression in a Steam CEF tab via DevTools Runtime.evaluate and return its JSON value. "
        "Defaults to SharedJSContext, where Decky's frontend (window.DeckyPluginLoader) lives. "
        "Promises are awaited. Wrap statements in an IIFE or async IIFE to return a value.",
        {
            "properties": {
                "expression": {"type": "string"},
                "target": {"type": "string", "description": "Tab title to target, e.g. 'SharedJSContext' or 'QuickAccess_uid2'"},
                "timeout": {"type": "number", "default": 15},
            },
            "required": ["expression"],
        },
    )
    async def cef_evaluate(expression: str, target: str | None = None, timeout: float = 15) -> Any:
        value = await cdp.evaluate_in(target, expression, timeout=timeout)
        return value if value is not None else "undefined"

    @reg.add(
        "cef_screenshot",
        "Capture a PNG screenshot of a Steam CEF tab (default: the main Big Picture window). "
        "For the whole display including games use screen_capture instead.",
        {"properties": {"target": {"type": "string"}, "quality_scale": {"type": "number", "default": 0.5, "minimum": 0.1, "maximum": 1}}},
    )
    async def cef_screenshot(target: str | None = None, quality_scale: float = 0.5) -> list[dict[str, Any]]:
        tab_title = target
        if tab_title is None:
            titles = [t.get("title", "") for t in await cdp.list_targets()]
            tab_title = next((t for t in titles if t.startswith("Steam Big Picture Mode")), None) or "SharedJSContext"
        t = await cdp.find_target(tab_title)
        async with cdp.Tab(t) as tab:
            metrics = await tab.send("Page.getLayoutMetrics")
            css = metrics.get("cssVisualViewport", {})
            res = await tab.send("Page.captureScreenshot", {
                "format": "png",
                "clip": {"x": 0, "y": 0, "width": css.get("clientWidth", 1280), "height": css.get("clientHeight", 800), "scale": quality_scale},
            }, timeout=30)
        return [
            {"type": "text", "text": f"Screenshot of '{tab_title}' at scale {quality_scale}"},
            {"type": "image", "data": res["data"], "mimeType": "image/png"},
        ]

    @reg.add(
        "ui_toast",
        "Show a Decky toast notification in the Steam UI.",
        {"properties": {"title": {"type": "string"}, "body": {"type": "string"}, "duration_ms": {"type": "integer", "default": 5000}},
         "required": ["title", "body"]},
    )
    async def ui_toast(title: str, body: str, duration_ms: int = 5000) -> str:
        return await toast(title, body, duration_ms)
