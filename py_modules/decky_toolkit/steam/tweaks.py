"""Decky Toolkit's own Steam UI tweaks: the frontend registry (`src/steam/tweak.ts`, published in SharedJSContext as
`window.__deckyToolkitSteam`) and the saved list of tweaks that stay off.

The setting lives here; the frontend reads it from `get_status` at load and follows the `decky_toolkit_ui_tweaks`
event. Turning one tweak on or off goes through the frontend first because only it knows the names in use ("all").
"""
import json
import logging
import time
from typing import Any, Awaitable, Callable

from ..server.events import EventHub
from ..settings import Settings
from . import cdp

Evaluate = Callable[[str], Awaitable[Any]]
API = "window.__deckyToolkitSteam"
MAX_TRIAL_SECONDS = 300
NOT_LOADED = ("Decky Toolkit's frontend is not loaded in Steam (no window.__deckyToolkitSteam in SharedJSContext); "
              "plugin_reload it with mode frontend")


def _countdown(t: dict[str, Any]) -> dict[str, Any]:
    if t.get("reverts_at"):
        t["reverts_in_s"] = max(0.0, round(t.pop("reverts_at") / 1000 - time.time(), 1))
    return t


def _call(expr: str) -> str:
    # One function scope per evaluation: SharedJSContext keeps top-level declarations between calls.
    return f"(() => {{ const t = {API}; if (!t || t.version !== 1) return null; {expr} }})()"


class UiTweaks:
    def __init__(self, get_settings: Callable[[], Settings], save_settings: Callable[[], None] | None,
                 events: EventHub, logger: logging.Logger, evaluate: Evaluate | None = None) -> None:
        self._get_settings, self._save, self.events, self.log = get_settings, save_settings, events, logger
        self._eval = evaluate or (lambda js: cdp.evaluate_in(None, js))

    def settings(self) -> dict[str, Any]:
        return {"off": list(self._get_settings().ui_tweaks_off)}

    def set_off(self, names: Any) -> dict[str, Any]:
        if self._get_settings().update_ui_tweaks_off(names):
            if self._save:
                self._save()
            off = self._get_settings().ui_tweaks_off
            self.log.info("ui tweaks off: %s", ", ".join(off) or "none")
            self.events.frontend("decky_toolkit_ui_tweaks", off)
            self.events.refresh("ui_tweaks")
        return self.settings()

    def set_one(self, name: str, on: bool) -> dict[str, Any]:
        off = set(self._get_settings().ui_tweaks_off)
        if on:
            off.discard(name)
        else:
            off.add(name)
        return self.set_off(sorted(off))

    async def _live(self, expr: str) -> Any:
        result = await self._eval(_call(expr))
        if result is None:
            raise cdp.CdpError(NOT_LOADED)
        return result

    async def list(self) -> dict[str, Any]:
        try:
            tweaks = [_countdown(t) for t in await self._live("return t.list();")]
        except cdp.CdpError as e:
            return {"tweaks": None, **self.settings(), "error": str(e)}
        return {"tweaks": tweaks, **self.settings()}

    async def set_enabled(self, name: str, on: bool) -> dict[str, Any]:
        if not isinstance(name, str) or not name:
            raise ValueError("name is required: a tweak name from ui_tweak list, or all")
        expr = f"try {{ t.setEnabled({json.dumps(name)}, {json.dumps(on)}); }} catch (e) {{ return {{error: String(e && e.message || e)}}; }} return {{tweaks: t.list(), off: t.off()}};"
        try:
            live = await self._live(expr)
        except cdp.CdpError as e:
            if name == "all" and not on:
                raise ValueError(f"{e}; without it the tweak names are unknown, so name one") from None
            saved = self.set_off([]) if name == "all" else self.set_one(name, on)
            return {"tweaks": None, **saved, "applied": False, "error": str(e)}
        if "error" in live:
            raise ValueError(live["error"])
        return {"tweaks": [_countdown(t) for t in live["tweaks"]], **self.set_off(live["off"]), "applied": True}

    async def trial(self, name: str, code: str, seconds: float) -> dict[str, Any]:
        if not isinstance(code, str) or not code.strip():
            raise ValueError("code is required: a JS function body that applies a patch and returns its undo function")
        if isinstance(seconds, bool) or not isinstance(seconds, (int, float)) or not 1 <= seconds <= MAX_TRIAL_SECONDS:
            raise ValueError(f"seconds must be 1-{MAX_TRIAL_SECONDS}")
        if name in self._get_settings().ui_tweaks_off:
            raise ValueError(f"{name!r} is a saved tweak name; give the trial another name")
        expr = (f"try {{ return t.try({json.dumps(name)}, function (track) {{\n{code}\n}}, {json.dumps(seconds)}); }} "
                "catch (e) { return {error: String(e && e.message || e)}; }")
        result = await self._live(expr)
        if "error" in result:
            raise ValueError(result["error"])
        return _countdown(result)
