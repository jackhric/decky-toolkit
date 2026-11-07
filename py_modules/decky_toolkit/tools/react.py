"""ui_react and ui_tweak: looking at Steam's React and switching or trying patches on it."""
from typing import Any

from ..steam.react import MAX_DOWN, MAX_FIND, MAX_UP, ReactInspector
from ..steam.tweaks import MAX_TRIAL_SECONDS, UiTweaks
from ..steam.ui import QUERY_TARGET
from . import ToolRegistry
from .system import require_confirm

REACT_ARGS = {"find": ("grep", "limit"), "tree": ("selector", "target", "depth", "down"),
              "patches": ("ref", "selector", "target", "depth")}
TWEAK_ARGS = {"list": (), "on": ("name", "confirm"), "off": ("name", "confirm"),
              "try": ("name", "code", "seconds", "confirm")}


def _only(kind: str, value: str, allowed: dict[str, tuple[str, ...]], given: dict[str, Any]) -> None:
    extra = sorted(k for k, v in given.items() if v is not None and k not in allowed[value])
    if extra:
        takes = ", ".join(allowed[value]) or "nothing else"
        raise ValueError(f"{kind} {value!r} does not take {', '.join(extra)} (it takes {takes})")


def register(reg: ToolRegistry, react: ReactInspector, tweaks: UiTweaks) -> None:
    @reg.add(
        "ui_react",
        "Read-only look at Steam's React, for building UI patches. mode find: webpack exports whose source contains "
        "every grep string (@decky/ui's module list); each match has ref (module:export, valid until Steam updates; "
        "patch code should match the same strings with DFL.findModuleExport), kind (memo|forwardRef|function|class), "
        "an excerpt around the first hit and patched (wrapper count). mode tree: from the element matching selector in "
        f"target (default '{QUERY_TARGET}'), the fibers up depth levels and down levels below, one line each: level, "
        "kind, name, key, [error boundary], patched=ours|other, props, src. mode patches: for ref, or the components "
        "above selector, the __deckyPatch chain on the function React renders: depth, layers (ours: the tweak name of a "
        "Decky Toolkit wrapper, else null) and fiber_current (false: a memo fiber still renders an old function, a "
        "leftover of an unpatch without the fiber update).",
        {"properties": {
            "mode": {"type": "string", "enum": list(REACT_ARGS)},
            "grep": {"type": "array", "items": {"type": "string"}, "description": "find: substrings, all required"},
            "limit": {"type": "integer", "default": 10, "minimum": 1, "maximum": MAX_FIND},
            "selector": {"type": "string"},
            "target": {"type": "string", "default": QUERY_TARGET},
            "ref": {"type": "string", "description": "patches: a ref from find"},
            "depth": {"type": "integer", "default": 10, "minimum": 0, "maximum": MAX_UP},
            "down": {"type": "integer", "default": 0, "minimum": 0, "maximum": MAX_DOWN},
        }, "required": ["mode"]},
    )
    async def ui_react(mode: str, grep: Any = None, limit: int | None = None, selector: str | None = None,
                       target: str | None = None, ref: str | None = None, depth: int | None = None,
                       down: int | None = None) -> dict[str, Any]:
        if mode not in REACT_ARGS:
            raise ValueError(f"mode must be one of {', '.join(REACT_ARGS)}")
        _only("mode", mode, REACT_ARGS, {"grep": grep, "limit": limit, "selector": selector, "target": target,
                                         "ref": ref, "depth": depth, "down": down})
        if mode == "find":
            if grep is None:
                raise ValueError("find needs grep")
            return await react.find(grep, 10 if limit is None else limit)
        if mode == "tree":
            if not selector:
                raise ValueError("tree needs selector")
            return await react.tree(selector, target, 10 if depth is None else depth, down or 0)
        return await react.patches(ref, selector, target, 10 if depth is None else depth)

    @reg.add(
        "ui_tweak",
        "Decky Toolkit's own changes to the Steam UI, and trial patches. action list (default): {tweaks: [{name, "
        "status: active|skipped (an internal is missing)|failed (message)|off|idle (not in use right now), trial?, "
        "reverts_in_s?}], off (saved)}. on/off with name (or all) and confirm: true: switches it now and saves it, so it "
        "stays off across reloads. try with code and confirm: true: runs code as the body of function (track) in "
        "SharedJSContext (window.DFL has afterPatch, findModuleExport, getReactInstance, ...); it applies a patch and "
        "returns its undo function (track(undo) registers partial undos, run if it throws). After seconds (default 30, "
        f"max {MAX_TRIAL_SECONDS}) the undo runs by itself; action off with the trial's name runs it now. Returns "
        "{name, status, message?, reverts_in_s}. Set handler.__deckyToolkit = name on a patch handler so ui_react "
        "shows the wrapper as ours.",
        {"properties": {
            "action": {"type": "string", "enum": list(TWEAK_ARGS), "default": "list"},
            "name": {"type": "string", "description": "on/off: a tweak from list, or all; try: default trial"},
            "code": {"type": "string"},
            "seconds": {"type": "number", "default": 30, "minimum": 1, "maximum": MAX_TRIAL_SECONDS},
            "confirm": {"type": "boolean"},
        }},
    )
    async def ui_tweak(action: str = "list", name: str | None = None, code: str | None = None,
                       seconds: float | None = None, confirm: bool | None = None) -> dict[str, Any]:
        if action not in TWEAK_ARGS:
            raise ValueError(f"action must be one of {', '.join(TWEAK_ARGS)}")
        _only("action", action, TWEAK_ARGS, {"name": name, "code": code, "seconds": seconds, "confirm": confirm})
        if action == "list":
            return await tweaks.list()
        if action == "try":
            require_confirm(confirm, "ui_tweak try runs code that patches the Steam UI")
            return await tweaks.trial(name or "trial", code or "", 30 if seconds is None else seconds)
        if not name:
            raise ValueError(f"{action} needs name: a tweak from ui_tweak list, or all")
        require_confirm(confirm, f"ui_tweak {action} changes the Steam UI and saves the choice")
        return await tweaks.set_enabled(name, action == "on")
