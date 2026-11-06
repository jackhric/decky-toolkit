"""Keyboard, mouse and gamepad injection tools (refused while remote input is disabled)."""
import asyncio
import base64
from typing import Any

from ..media.capture import CaptureUnavailable, ScreenCapturer
from ..input import keymap
from ..input.service import InputDisabled, InputService, InputUnavailable, Session, mouse_button, pad_values
from . import ToolRegistry

CAPTURE_PROP = {"type": "boolean", "default": False, "description": "Return a fresh screen frame after acting."}
# Steam opens a freshly created pad asynchronously; input sent before that is lost.
PAD_SETTLE_SECONDS = 1.5
CAPTURE_SETTLE_SECONDS = 0.25


def register(reg: ToolRegistry, service: InputService | None, capturer: ScreenCapturer | None) -> None:
    def svc() -> InputService:
        if service is None:
            raise InputUnavailable("input service not configured")
        return service

    async def run(fn, summary_fn, capture: bool) -> Any:
        s = svc()
        if not s.enabled:
            raise InputDisabled("remote input is disabled; call input_settings(enabled=true) or use the Decky Toolkit panel")
        session = s.open_session("MCP client", kind="mcp")
        try:
            result = await fn(s, session)
        finally:
            await s.close_session(session)
        summary = summary_fn(result) if summary_fn else result
        if not capture:
            return summary
        if capturer is None:
            raise CaptureUnavailable("screen capture not configured")
        await asyncio.sleep(CAPTURE_SETTLE_SECONDS)
        frame = await capturer.grab()
        return [{"type": "text", "text": summary if isinstance(summary, str) else str(summary)},
                {"type": "image", "data": base64.b64encode(frame).decode(), "mimeType": "image/jpeg"}]

    @reg.add(
        "input_settings",
        "Remote keyboard/mouse/gamepad input: {enabled, backend, available, reason}. Give enabled to turn it on or "
        "off (persisted, off by default). The Deck shows a toast when an input session starts.",
        {"properties": {"enabled": {"type": "boolean"}}},
    )
    async def input_settings(enabled: bool | None = None) -> dict[str, Any]:
        if enabled is None:
            return svc().state()
        return await svc().set_enabled(enabled)

    @reg.add(
        "input_key",
        "Press a key combo on the device keyboard, e.g. \"ctrl+shift+a\", \"enter\", \"KEY_F5\", \"ArrowDown\". "
        "A list presses several combos one after another. Keys go down in order, are held for hold_ms "
        "(games poll once per frame), then released in reverse.",
        {"properties": {
            "keys": {"anyOf": [{"type": "string"}, {"type": "array", "items": {"type": "string"}}],
                     "description": "Combo like \"ctrl+c\" (names: KeyboardEvent.code, KEY_*, ctrl/shift/alt/meta, "
                                    "enter/esc/tab/space/up/down/..., single characters; \"plus\" for +)."},
            "hold_ms": {"type": "integer", "default": 50, "minimum": 0, "maximum": 10000},
            "capture": CAPTURE_PROP,
        }, "required": ["keys"]},
    )
    async def input_key(keys: str | list[str], hold_ms: int = 50, capture: bool = False) -> Any:
        combos = [keys] if isinstance(keys, str) else keys
        if not isinstance(combos, list) or not combos:
            raise ValueError("keys must be a combo string or a non-empty list of them")
        parsed = [keymap.parse_combo(c) for c in combos]
        hold = max(0, min(10000, int(hold_ms))) / 1000

        async def act(s: InputService, session: Session) -> None:
            for i, codes in enumerate(parsed):
                if i:
                    await asyncio.sleep(0.03)
                try:
                    for code in codes:
                        await s.key(session, code, True)
                    await asyncio.sleep(hold)
                finally:
                    for code in reversed(codes):
                        await s.key(session, code, False)

        return await run(act, lambda _: f"pressed {', '.join(combos)} via {svc().backend_name()}", capture)

    @reg.add(
        "input_text",
        "Type ASCII text with a US keyboard layout (newline = Enter, tab = Tab). Non-ASCII is refused.",
        {"properties": {
            "text": {"type": "string"},
            "delay_ms": {"type": "integer", "default": 10, "minimum": 0, "maximum": 1000},
            "capture": CAPTURE_PROP,
        }, "required": ["text"]},
    )
    async def input_text(text: str, delay_ms: int = 10, capture: bool = False) -> Any:
        if not isinstance(text, str):
            raise ValueError("text must be a string")
        keymap.text_keys(text)

        async def act(s: InputService, session: Session) -> int:
            return await s.text(session, text, delay_ms=max(0, min(1000, int(delay_ms))))

        return await run(act, lambda n: f"typed {n} characters via {svc().backend_name()}", capture)

    @reg.add(
        "input_mouse",
        "Move, click or scroll the device pointer. x/y are normalised 0..1 across the focused window "
        "(the Steam UI is the full 1920x1080 screen), or pixels in that window with pixels=true; dx/dy move "
        "relatively in pixels. click/double/down/up move to x/y first when given. scroll: amount = vertical "
        "detents (positive = down), dx = horizontal detents.",
        {"properties": {
            "action": {"type": "string", "enum": ["move", "click", "double", "down", "up", "scroll"], "default": "move"},
            "x": {"type": "number"}, "y": {"type": "number"},
            "dx": {"type": "number"}, "dy": {"type": "number"},
            "button": {"type": "string", "enum": ["left", "right", "middle", "back", "forward"], "default": "left"},
            "amount": {"type": "integer", "default": 1},
            "pixels": {"type": "boolean", "default": False},
            "capture": CAPTURE_PROP,
        }},
    )
    async def input_mouse(action: str = "move", x: float | None = None, y: float | None = None,
                          dx: float | None = None, dy: float | None = None, button: str = "left",
                          amount: int = 1, pixels: bool = False, capture: bool = False) -> Any:
        if action not in ("move", "click", "double", "down", "up", "scroll"):
            raise ValueError("action must be move, click, double, down, up or scroll")
        if (x is None) != (y is None):
            raise ValueError("give both x and y")
        btn = mouse_button(button)

        async def act(s: InputService, session: Session) -> str:
            where = ""
            if x is not None and y is not None:
                px, py = await s.move_abs(session, float(x), float(y), pixels=bool(pixels))
                where = f" at {px:.0f},{py:.0f}"
            elif action != "scroll" and (dx is not None or dy is not None):
                await s.move_rel(session, float(dx or 0), float(dy or 0))
                where = f" by {dx or 0},{dy or 0}"
            elif action == "move":
                raise ValueError("move needs x/y or dx/dy")
            if action in ("click", "double"):
                for i in range(2 if action == "double" else 1):
                    if i:
                        await asyncio.sleep(0.06)
                    await s.button(session, btn, True)
                    await asyncio.sleep(0.03)
                    await s.button(session, btn, False)
            elif action == "down":
                await s.button(session, btn, True)
                # An MCP call is its own session, so keep the button held past close_session.
                session.buttons.discard(btn)
            elif action == "up":
                session.buttons.add(btn)
                await s.button(session, btn, False)
            elif action == "scroll":
                await s.wheel(session, int(dx or 0), int(amount))
            return f"{action}{where} via {s.backend_name()}"

        return await run(act, None, capture)

    @reg.add(
        "input_gamepad",
        "Drive a virtual Xbox 360 pad through Steam Input. pad: a virtual pad id from controller_add; "
        "without it an implicit 'auto' pad is created on first use and removed after 60 s idle. buttons: {a,b,x,y,lb,rb,back,start,guide,ls,rs,dpad_up/down/left/right: bool}; "
        "axes: {lx,ly,rx,ry: -1..1 (y down = +1), lt,rt: 0..1}; hat: [x,y] in -1..1. The state is held for "
        "hold_ms, then everything returns to neutral. sequence runs steps in order instead: "
        "{\"press\":\"a\",\"ms\":100}, {\"stick\":\"l\",\"x\":0,\"y\":-1,\"ms\":300}, "
        "{\"buttons\":{...},\"axes\":{...},\"hat\":[x,y],\"ms\":100} or {\"wait\":ms}. guide opens the Steam menu.",
        {"properties": {
            "buttons": {"type": "object"}, "axes": {"type": "object"},
            "hat": {"type": "array", "items": {"type": "integer"}, "minItems": 2, "maxItems": 2},
            "hold_ms": {"type": "integer", "default": 100, "minimum": 0, "maximum": 10000},
            "sequence": {"type": "array", "items": {"type": "object"}},
            "pad": {"type": "string", "description": "Virtual pad id (default: the implicit auto pad)."},
            "capture": CAPTURE_PROP,
        }},
    )
    async def input_gamepad(buttons: dict | None = None, axes: dict | None = None, hat: list | None = None,
                            hold_ms: int = 100, sequence: list | None = None, pad: str | None = None,
                            capture: bool = False) -> Any:
        if pad is not None and (not isinstance(pad, str) or (pad != "auto" and svc().get_pad(pad) is None)):
            raise ValueError(f"unknown virtual gamepad {pad!r}; have {', '.join(p.id for p in svc().pads()) or 'none'}")
        steps: list[tuple[dict, float]] = []
        if sequence is not None:
            if not isinstance(sequence, list) or not sequence:
                raise ValueError("sequence must be a non-empty list of steps")
            for step in sequence:
                if not isinstance(step, dict):
                    raise ValueError("each sequence step must be an object")
                ms = max(0, min(10000, int(step.get("ms", hold_ms))))
                if "wait" in step:
                    steps.append(({}, max(0, min(10000, int(step["wait"]))) / 1000))
                elif "press" in step:
                    steps.append((pad_values(buttons={step["press"]: True}), ms / 1000))
                elif "stick" in step:
                    side = str(step["stick"]).lower()[:1]
                    if side not in ("l", "r"):
                        raise ValueError("stick must be \"l\" or \"r\"")
                    steps.append((pad_values(axes={f"{side}x": step.get("x", 0), f"{side}y": step.get("y", 0)}), ms / 1000))
                else:
                    steps.append((pad_values(step.get("buttons"), step.get("axes"), step.get("hat")), ms / 1000))
        else:
            values = pad_values(buttons, axes, hat)
            if not values:
                raise ValueError("give buttons, axes, hat or sequence")
            steps.append((values, max(0, min(10000, int(hold_ms))) / 1000))

        async def act(s: InputService, session: Session) -> str:
            first = next((v for v, _ in steps if v), None)
            if first is not None and await s.gamepad(session, {k: 0 for k in first}, pad):
                await asyncio.sleep(PAD_SETTLE_SECONDS)
            for values, hold in steps:
                if values:
                    await s.gamepad(session, values, pad)
                await asyncio.sleep(hold)
                if values:
                    await s.gamepad(session, {k: 0 for k in values}, pad)
            return f"ran {len(steps)} gamepad step(s) on pad {pad or 'auto'}"

        return await run(act, None, capture)
