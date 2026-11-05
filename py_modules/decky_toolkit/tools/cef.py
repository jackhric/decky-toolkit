"""Tools that drive the Steam client through its CEF DevTools port."""
import json
from typing import Any

from .. import cdp
from ..console import DEFAULT_LEVEL, DEFAULT_TARGETS, LEVELS, ConsoleCollector
from . import ToolRegistry


def register(reg: ToolRegistry, console: ConsoleCollector | None = None) -> None:
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
        "toast",
        "Show a Decky toast notification in the Steam UI.",
        {"properties": {"title": {"type": "string"}, "body": {"type": "string"}, "duration_ms": {"type": "integer", "default": 5000}},
         "required": ["title", "body"]},
    )
    async def toast(title: str, body: str, duration_ms: int = 5000) -> str:
        js = ("(async () => { const t = window.DeckyPluginLoader?.toaster; if (!t) throw new Error('DeckyPluginLoader.toaster missing');"
              f" t.toast({{ title: {json.dumps(title)}, body: {json.dumps(body)}, duration: {int(duration_ms)} }}); return 'ok'; }})()")
        return await cdp.evaluate_in(None, js)

    def collector() -> ConsoleCollector:
        if console is None:
            raise ValueError("console capture is not running in this server")
        return console

    @reg.add(
        "cef_console",
        "Steam UI console output captured in the background (no need to start anything): console.* calls, uncaught "
        "exceptions and unhandled rejections, and browser log entries (network, violations), up to 2000 per tab. "
        f"target: {', '.join(DEFAULT_TARGETS)} (default {DEFAULT_TARGETS[0]}, where Decky and plugin frontends run) or "
        "'all'. level is a minimum (debug < log = info < warn < error; default info). since: an entry id (returns "
        "newer ones; pass the previous call's last_id) or an ISO time. grep: case-insensitive substring of text or url. "
        "Returns {target, status, last_id, count, entries: [{id, target, time, source: console|exception|log, type, "
        "level, text, url?, line?, column?, function?}]}.",
        {"properties": {
            "target": {"type": "string", "default": DEFAULT_TARGETS[0]},
            "lines": {"type": "integer", "default": 200, "minimum": 1, "maximum": 4000},
            "level": {"type": "string", "enum": list(LEVELS), "default": DEFAULT_LEVEL},
            "since": {"type": ["string", "integer"], "description": "entry id or ISO time"},
            "grep": {"type": "string"},
        }},
    )
    async def cef_console(target: str | None = None, lines: int = 200, level: str | None = DEFAULT_LEVEL,
                          since: Any = None, grep: str | None = None) -> dict[str, Any]:
        return collector().query(target, lines, level, since, grep)

    @reg.add(
        "cef_console_clear",
        "Clear the captured console buffer of one target, or of every target when target is omitted.",
        {"properties": {"target": {"type": "string"}}},
    )
    async def cef_console_clear(target: str | None = None) -> dict[str, Any]:
        return {"cleared": collector().clear(target)}
