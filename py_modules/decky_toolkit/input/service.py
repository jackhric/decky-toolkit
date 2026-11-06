"""InputService: owns the input backends, the enabled flag, held-key tracking and the virtual gamepads."""
import asyncio
import logging
import os
import re
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Protocol

from . import ei, keymap, uinput
from ..media.capture import _user_runtime_dir

PAD_IDLE_SECONDS = 60.0
MAX_PADS = 4
AUTO_PAD = "auto"
RATE_PER_SECOND = 1000
FOCUS_CACHE_SECONDS = 1.0
DEFAULT_FOCUS = (1920, 1080)
ANNOUNCE_EVERY_SECONDS = 60.0
EI_RETRY_SECONDS = 30.0
MAX_TEXT = 2000
MAX_WHEEL = 20

MOUSE_BUTTONS = {"left": uinput.BTN_LEFT, "right": uinput.BTN_RIGHT, "middle": uinput.BTN_MIDDLE,
                 "back": uinput.BTN_SIDE, "forward": uinput.BTN_EXTRA}
PAD_BUTTONS = {"a": uinput.BTN_A, "b": uinput.BTN_B, "x": uinput.BTN_X, "y": uinput.BTN_Y,
               "lb": uinput.BTN_TL, "rb": uinput.BTN_TR, "back": uinput.BTN_SELECT, "start": uinput.BTN_START,
               "guide": uinput.BTN_MODE, "ls": uinput.BTN_THUMBL, "rs": uinput.BTN_THUMBR}
PAD_BUTTON_ALIASES = {"tl": "lb", "tr": "rb", "l1": "lb", "r1": "rb", "select": "back", "view": "back",
                      "menu": "start", "mode": "guide", "home": "guide", "thumbl": "ls", "thumbr": "rs",
                      "l3": "ls", "r3": "rs"}
PAD_DPAD = {"dpad_up": (1, -1), "dpad_down": (1, 1), "dpad_left": (0, -1), "dpad_right": (0, 1)}
PAD_STICKS = {"lx": uinput.ABS_X, "ly": uinput.ABS_Y, "rx": uinput.ABS_RX, "ry": uinput.ABS_RY}
PAD_TRIGGERS = {"lt": uinput.ABS_Z, "rt": uinput.ABS_RZ}

OnSession = Callable[[str], Awaitable[None]]


class InputDisabled(RuntimeError):
    pass


class InputUnavailable(RuntimeError):
    pass


class Backend(Protocol):
    name: str

    async def open(self) -> None: ...
    def key(self, code: int, down: bool) -> None: ...
    def button(self, code: int, down: bool) -> None: ...
    def move_abs(self, x: float, y: float) -> None: ...
    def move_rel(self, dx: float, dy: float) -> None: ...
    def scroll(self, dx: int, dy: int) -> None: ...
    def frame(self) -> None: ...
    def close(self) -> None: ...


class EiBackend:
    name = "ei"

    def __init__(self, path: str, logger: logging.Logger):
        self.sender = ei.EiSender(path, logger)
        self.path = path

    async def open(self) -> None:
        await self.sender.ensure()

    def key(self, code: int, down: bool) -> None:
        self.sender.key(code, down)

    def button(self, code: int, down: bool) -> None:
        self.sender.button(code, down)

    def move_abs(self, x: float, y: float) -> None:
        self.sender.move_abs(x, y)

    def move_rel(self, dx: float, dy: float) -> None:
        self.sender.move_rel(dx, dy)

    def scroll(self, dx: int, dy: int) -> None:
        self.sender.scroll(dx, dy)

    def frame(self) -> None:
        self.sender.frame()

    def close(self) -> None:
        self.sender.close()


class UinputBackend:
    """Fallback when gamescope has no EIS socket: a virtual keyboard plus a relative mouse."""
    name = "uinput"

    def __init__(self) -> None:
        self.kbd: uinput.Device | None = None
        self.mouse: uinput.Device | None = None
        self._kbd_events: list[tuple[int, int, int]] = []
        self._mouse_events: list[tuple[int, int, int]] = []

    async def open(self) -> None:
        if self.kbd and self.mouse:
            return
        try:
            self.kbd = uinput.Device("Decky Toolkit Keyboard", keys=range(1, 249))
            self.mouse = uinput.Device("Decky Toolkit Mouse", keys=list(MOUSE_BUTTONS.values()),
                                       rels=(uinput.REL_X, uinput.REL_Y, uinput.REL_WHEEL, uinput.REL_HWHEEL))
        except OSError as e:
            self.close()
            raise InputUnavailable(f"cannot create uinput devices: {e}") from None
        # gamescope opens new evdev devices asynchronously (observed ~1.5 s); earlier events are lost.
        await asyncio.sleep(1.5)

    def key(self, code: int, down: bool) -> None:
        self._kbd_events.append((uinput.EV_KEY, code, int(down)))

    def button(self, code: int, down: bool) -> None:
        self._mouse_events.append((uinput.EV_KEY, code, int(down)))

    def move_abs(self, x: float, y: float) -> None:
        # gamescope ignores absolute evdev pointers, so pin the cursor to 0,0 with a huge relative
        # move, then move to the target. Wrong inside games that lock or recentre the pointer.
        assert self.mouse
        self.mouse.emit([(uinput.EV_REL, uinput.REL_X, -100000), (uinput.EV_REL, uinput.REL_Y, -100000)])
        self.move_rel(x, y)

    def move_rel(self, dx: float, dy: float) -> None:
        self._mouse_events += [(uinput.EV_REL, uinput.REL_X, round(dx)), (uinput.EV_REL, uinput.REL_Y, round(dy))]

    def scroll(self, dx: int, dy: int) -> None:
        # evdev wheel is positive away from the user (up); our dy is positive down.
        if dy:
            self._mouse_events.append((uinput.EV_REL, uinput.REL_WHEEL, -int(dy)))
        if dx:
            self._mouse_events.append((uinput.EV_REL, uinput.REL_HWHEEL, int(dx)))

    def frame(self) -> None:
        if self._kbd_events and self.kbd:
            self.kbd.emit(self._kbd_events)
        if self._mouse_events and self.mouse:
            self.mouse.emit(self._mouse_events)
        self._kbd_events, self._mouse_events = [], []

    def close(self) -> None:
        for dev in (self.kbd, self.mouse):
            if dev:
                dev.close()
        self.kbd = self.mouse = None


class Gamepad:
    """Virtual Xbox 360 pad; Steam opens the evdev node itself and maps it like the real thing."""
    STICK = (-32768, 32767, 16, 128, 0)

    def __init__(self) -> None:
        self.dev = uinput.Device(
            "Microsoft X-Box 360 pad", bustype=uinput.BUS_USB, vendor=0x045E, product=0x028E, version=0x0114,
            keys=list(PAD_BUTTONS.values()),
            abs={**{c: self.STICK for c in PAD_STICKS.values()}, **{c: (0, 255, 0, 0, 0) for c in PAD_TRIGGERS.values()},
                 uinput.ABS_HAT0X: (-1, 1, 0, 0, 0), uinput.ABS_HAT0Y: (-1, 1, 0, 0, 0)})
        self.state: dict[tuple[int, int], int] = {}

    def apply(self, values: dict[tuple[int, int], int]) -> None:
        changed = [(t, c, v) for (t, c), v in values.items() if self.state.get((t, c), 0) != v]
        if changed:
            self.dev.emit(changed)
            for t, c, v in changed:
                self.state[(t, c)] = v

    def neutral(self) -> None:
        self.apply({k: 0 for k, v in self.state.items() if v})

    @property
    def sysname(self) -> str | None:
        return self.dev.sysname

    def close(self) -> None:
        self.dev.close()


@dataclass(eq=False)
class VirtualPad:
    id: str
    name: str
    dev: Any
    auto: bool = False
    type: str = "x360"
    created_at: float = field(default_factory=time.time)
    last_event_at: float | None = None
    last_used: float = field(default_factory=time.monotonic)
    # Steam Input's strSerialNumber for this pad once seen, so the controller list can pair them exactly.
    steam_serial: str | None = None

    @property
    def sysname(self) -> str | None:
        return getattr(self.dev, "sysname", None)

    def info(self) -> dict[str, Any]:
        return {"id": self.id, "name": self.name, "type": self.type, "created_at": self.created_at,
                "last_event_at": self.last_event_at, "auto": self.auto}


@dataclass(eq=False)
class Session:
    remote: str
    kind: str = "ws"
    keys: set[int] = field(default_factory=set)
    buttons: set[int] = field(default_factory=set)
    used_pads: set[str] = field(default_factory=set)
    started: bool = False


def pad_values(buttons: dict[str, Any] | None = None, axes: dict[str, Any] | None = None,
               hat: list[int] | tuple[int, int] | None = None) -> dict[tuple[int, int], int]:
    """Validate a gamepad message into {(EV_type, code): value}; only the given fields are included."""
    out: dict[tuple[int, int], int] = {}
    hat_xy: list[int | None] = [None, None]
    if buttons is not None:
        if not isinstance(buttons, dict):
            raise ValueError("buttons must be an object of name: bool")
        for name, pressed in buttons.items():
            key = PAD_BUTTON_ALIASES.get(str(name).lower(), str(name).lower())
            if key in PAD_DPAD:
                axis, direction = PAD_DPAD[key]
                if pressed:
                    hat_xy[axis] = direction
                elif hat_xy[axis] is None:
                    hat_xy[axis] = 0
                continue
            if key not in PAD_BUTTONS:
                raise ValueError(f"unknown gamepad button {name!r}; use {', '.join([*PAD_BUTTONS, *PAD_DPAD])}")
            out[(uinput.EV_KEY, PAD_BUTTONS[key])] = 1 if pressed else 0
    if axes is not None:
        if not isinstance(axes, dict):
            raise ValueError("axes must be an object of name: number")
        for name, value in axes.items():
            v = _number(f"axis {name}", value)
            if name in PAD_STICKS:
                out[(uinput.EV_ABS, PAD_STICKS[name])] = round(max(-1.0, min(1.0, v)) * (32767 if v > 0 else 32768))
            elif name in PAD_TRIGGERS:
                out[(uinput.EV_ABS, PAD_TRIGGERS[name])] = round(max(0.0, min(1.0, v)) * 255)
            else:
                raise ValueError(f"unknown gamepad axis {name!r}; use lx, ly, rx, ry, lt, rt")
    if hat is not None:
        if not isinstance(hat, (list, tuple)) or len(hat) != 2:
            raise ValueError("hat must be [x, y] with values -1, 0 or 1")
        hat_xy = [max(-1, min(1, int(_number("hat", h)))) for h in hat]
    if hat_xy[0] is not None:
        out[(uinput.EV_ABS, uinput.ABS_HAT0X)] = hat_xy[0]
    if hat_xy[1] is not None:
        out[(uinput.EV_ABS, uinput.ABS_HAT0Y)] = hat_xy[1]
    return out


def _number(name: str, value: Any) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be a number")
    return float(value)


def _bool(name: str, value: Any) -> bool:
    if not isinstance(value, bool):
        raise ValueError(f"{name} must be true or false")
    return value


def mouse_button(name: Any) -> int:
    if isinstance(name, str) and name.lower() in MOUSE_BUTTONS:
        return MOUSE_BUTTONS[name.lower()]
    if isinstance(name, int) and not isinstance(name, bool) and 0 <= name < 5:
        # DOM MouseEvent.button numbering: 0 left, 1 middle, 2 right, 3 back, 4 forward.
        return (uinput.BTN_LEFT, uinput.BTN_MIDDLE, uinput.BTN_RIGHT, uinput.BTN_SIDE, uinput.BTN_EXTRA)[name]
    raise ValueError(f"unknown mouse button {name!r}; use {', '.join(MOUSE_BUTTONS)}")


def _clean_env() -> dict[str, str]:
    return {k: v for k, v in os.environ.items() if k != "LD_LIBRARY_PATH"}


async def xdotool_focus_size() -> tuple[int, int] | None:
    """Focused X window size on the Steam display, via xdotool as the desktop user (root is refused by X)."""
    cmd = ["xdotool", "getwindowfocus", "getwindowgeometry"]
    for display in (":0", ":1"):
        env = _clean_env()
        env["DISPLAY"] = display
        argv = cmd
        if os.geteuid() == 0:
            user = os.environ.get("DECKY_USER", "deck")
            argv = ["runuser", "-u", user, "--", "env", f"DISPLAY={display}", *cmd]
        try:
            proc = await asyncio.create_subprocess_exec(*argv, env=env, stdout=asyncio.subprocess.PIPE,
                                                        stderr=asyncio.subprocess.DEVNULL)
            out, _ = await asyncio.wait_for(proc.communicate(), 2)
        except (FileNotFoundError, asyncio.TimeoutError):
            continue
        m = re.search(rb"Geometry:\s*(\d+)x(\d+)", out)
        if m and int(m.group(1)) > 1 and int(m.group(2)) > 1:
            return int(m.group(1)), int(m.group(2))
    return None


class InputService:
    def __init__(self, get_settings: Callable[[], Any], save_settings: Callable[[], None] | None, logger: logging.Logger,
                 on_session: OnSession | None = None, *, runtime_dir: Callable[[], str] = _user_runtime_dir,
                 make_backend: Callable[[str], Backend] | None = None, make_gamepad: Callable[[], Gamepad] | None = None,
                 uinput_available: Callable[[], bool] = uinput.available,
                 focus_probe: Callable[[], Awaitable[tuple[int, int] | None]] = xdotool_focus_size,
                 pad_idle: float = PAD_IDLE_SECONDS, rate: int = RATE_PER_SECOND):
        self._get_settings = get_settings
        self._save_settings = save_settings
        self.log = logger
        self.on_session = on_session
        self._runtime_dir = runtime_dir
        self._make_backend = make_backend or self._default_backend
        self._make_gamepad = make_gamepad or Gamepad
        self._uinput_available = uinput_available
        self._focus_probe = focus_probe
        self.pad_idle = pad_idle
        self.rate = rate
        self._backend: Backend | None = None
        self._backend_lock = asyncio.Lock()
        # Last injected event (not releases): wall time, client and session kind, for device_activity.
        self.last_remote: dict[str, Any] | None = None
        self._ei_failed_at = -EI_RETRY_SECONDS
        self._pads: dict[str, VirtualPad] = {}
        self._pad_seq = 0
        self._pad_task: asyncio.Task[None] | None = None
        self._pad_listeners: set[Callable[[], None]] = set()
        self._sessions: set[Session] = set()
        self._listeners: set[Callable[[dict[str, Any]], None]] = set()
        self._announced: dict[str, float] = {}
        self._focus: tuple[int, int] = DEFAULT_FOCUS
        self._focus_at = -FOCUS_CACHE_SECONDS
        self._focus_lock = asyncio.Lock()
        self._tokens = float(rate)
        self._tokens_at = time.monotonic()

    # ---- state ----

    @property
    def enabled(self) -> bool:
        return bool(getattr(self._get_settings(), "input_enabled", False))

    def _ei_socket(self) -> str | None:
        return ei.find_socket(self._runtime_dir())

    def backend_name(self) -> str | None:
        if self._backend is not None:
            return self._backend.name
        if self._ei_socket() and time.monotonic() - self._ei_failed_at >= EI_RETRY_SECONDS:
            return "ei"
        if self._uinput_available():
            return "uinput"
        return None

    def unavailable_reason(self) -> str | None:
        if self.backend_name() is not None:
            return None
        return (f"no gamescope libei socket ({' or '.join(ei.SOCKET_NAMES)}) in {self._runtime_dir()} "
                f"and {uinput.DEV_PATH} is not writable")

    def status(self) -> dict[str, Any]:
        reason = self.unavailable_reason()
        return {"enabled": self.enabled, "backend": self.backend_name(), "available": reason is None, "reason": reason}

    def state(self) -> dict[str, Any]:
        return {"type": "state", "enabled": self.enabled, "backend": self.backend_name(), "focus_size": list(self._focus)}

    def add_listener(self, fn: Callable[[dict[str, Any]], None]) -> None:
        self._listeners.add(fn)

    def remove_listener(self, fn: Callable[[dict[str, Any]], None]) -> None:
        self._listeners.discard(fn)

    def _notify(self) -> None:
        st = self.state()
        for fn in list(self._listeners):
            fn(st)

    async def set_enabled(self, enabled: Any) -> dict[str, Any]:
        if self._get_settings().update_input(enabled):
            if self._save_settings:
                self._save_settings()
            self.log.info("remote input %s", "enabled" if enabled else "disabled")
            if not enabled:
                await self.release_all()
                self._close_devices(keep_explicit_pads=True)
            self._notify()
        return self.status()

    # ---- backends ----

    def _default_backend(self, name: str) -> Backend:
        if name == "ei":
            path = self._ei_socket()
            if not path:
                raise InputUnavailable("gamescope libei socket disappeared")
            return EiBackend(path, self.log)
        return UinputBackend()

    async def _get_backend(self) -> Backend:
        async with self._backend_lock:
            b = self._backend
            if b is not None:
                # gamescope restarted under another display name, or the EIS socket went away.
                if isinstance(b, EiBackend) and b.path != self._ei_socket():
                    b.close()
                    self._backend = b = None
                else:
                    try:
                        await b.open()
                        return b
                    except (ei.EiError, InputUnavailable) as e:
                        self.log.warning("input backend %s lost: %s", b.name, e)
                        b.close()
                        self._backend = None
                        if b.name == "ei":
                            self._ei_failed_at = time.monotonic()
            name = self.backend_name()
            if name is None:
                raise InputUnavailable(self.unavailable_reason() or "no input backend")
            backend = self._make_backend(name)
            try:
                await backend.open()
            except (ei.EiError, InputUnavailable) as e:
                backend.close()
                if name != "ei" or not self._uinput_available():
                    raise InputUnavailable(str(e)) from None
                self.log.warning("libei unavailable (%s); falling back to uinput", e)
                self._ei_failed_at = time.monotonic()
                backend = self._make_backend("uinput")
                await backend.open()
            self._backend = backend
            self.log.info("input backend: %s", backend.name)
            self._notify()
            return backend

    def _close_devices(self, keep_explicit_pads: bool = False) -> None:
        if self._backend is not None:
            self._backend.close()
            self._backend = None
        for pad in list(self._pads.values()):
            if pad.auto or not keep_explicit_pads:
                self._close_pad(pad.id)
            else:
                try:
                    pad.dev.neutral()
                except OSError:
                    pass

    # ---- virtual gamepads ----

    def pads(self) -> list[VirtualPad]:
        return sorted(self._pads.values(), key=lambda p: p.created_at)

    def get_pad(self, pad_id: str) -> VirtualPad | None:
        return self._pads.get(pad_id)

    def add_pad_listener(self, fn: Callable[[], None]) -> None:
        self._pad_listeners.add(fn)

    def remove_pad_listener(self, fn: Callable[[], None]) -> None:
        self._pad_listeners.discard(fn)

    def _pads_changed(self) -> None:
        for fn in list(self._pad_listeners):
            fn()

    def _create_pad(self, pad_id: str, name: str, auto: bool) -> VirtualPad:
        if not self._uinput_available():
            raise InputUnavailable(f"{uinput.DEV_PATH} is not writable; no virtual gamepad")
        try:
            dev = self._make_gamepad()
        except OSError as e:
            raise InputUnavailable(f"cannot create the virtual gamepad: {e}") from None
        pad = VirtualPad(pad_id, name, dev, auto=auto)
        self._pads[pad_id] = pad
        self.log.info("virtual gamepad %s (%s) created as %s", pad_id, name, pad.sysname)
        self._pads_changed()
        return pad

    def add_pad(self, name: Any = None) -> VirtualPad:
        """An explicit pad: lives until removed (no idle timeout) and does not need input enabled to exist."""
        if name is not None and not isinstance(name, str):
            raise ValueError("name must be a string")
        name = " ".join((name or "").split())[:64]
        explicit = [p for p in self._pads.values() if not p.auto]
        if len(explicit) >= MAX_PADS:
            raise ValueError(f"at most {MAX_PADS} virtual gamepads; remove one first")
        self._pad_seq += 1
        return self._create_pad(f"pad{self._pad_seq}", name or f"Virtual pad {self._pad_seq}", auto=False)

    def remove_pad(self, pad_id: str) -> bool:
        if pad_id not in self._pads:
            return False
        self._close_pad(pad_id)
        return True

    def _close_pad(self, pad_id: str) -> None:
        pad = self._pads.pop(pad_id, None)
        if pad is not None:
            try:
                pad.dev.neutral()
            except OSError:
                pass
            finally:
                pad.dev.close()
            self.log.info("virtual gamepad %s removed", pad_id)
            self._pads_changed()
        if AUTO_PAD not in self._pads and self._pad_task is not None:
            if self._pad_task is not asyncio.current_task():
                self._pad_task.cancel()
            self._pad_task = None

    async def focus_size(self) -> tuple[int, int]:
        async with self._focus_lock:
            if time.monotonic() - self._focus_at >= FOCUS_CACHE_SECONDS:
                try:
                    size = await self._focus_probe()
                except Exception as e:  # noqa: BLE001
                    self.log.warning("focus size lookup failed: %s", e)
                    size = None
                size = tuple(size) if size else DEFAULT_FOCUS
                self._focus_at = time.monotonic()
                if size != self._focus:
                    self._focus = size  # type: ignore[assignment]
                    self._notify()
            return self._focus

    # ---- sessions ----

    def open_session(self, remote: str, kind: str = "ws") -> Session:
        s = Session(remote or "?", kind)
        self._sessions.add(s)
        return s

    async def close_session(self, s: Session) -> None:
        await self.release(s)
        self._sessions.discard(s)
        if s.started:
            self.log.info("input session from %s (%s) ended", s.remote, s.kind)

    async def release(self, s: Session) -> None:
        if s.keys or s.buttons:
            self.log.info("input session %s: releasing held keys %s, buttons %s", s.remote, sorted(s.keys), sorted(s.buttons))
            b = self._backend
            if b is not None:
                try:
                    for code in s.keys:
                        b.key(code, False)
                    for code in s.buttons:
                        b.button(code, False)
                    b.frame()
                except (ei.EiError, OSError) as e:
                    self.log.warning("releasing held input failed: %s", e)
            s.keys.clear()
            s.buttons.clear()
        for pad_id in s.used_pads:
            if (pad := self._pads.get(pad_id)) is not None:
                try:
                    pad.dev.neutral()
                except OSError:
                    pass
        s.used_pads.clear()

    async def release_all(self) -> None:
        for s in list(self._sessions):
            await self.release(s)

    async def shutdown(self) -> None:
        await self.release_all()
        self._close_devices()

    async def _begin(self, s: Session, releasing: bool = False) -> None:
        if not self.enabled:
            if releasing:
                return
            raise InputDisabled("remote input is disabled; enable it in the Decky Toolkit panel, the VS Code "
                                "screen panel, PUT /input/settings or the set_input_enabled tool")
        if not releasing:
            now = time.monotonic()
            self._tokens = min(float(self.rate), self._tokens + (now - self._tokens_at) * self.rate)
            self._tokens_at = now
            if self._tokens < 1:
                raise ValueError(f"input rate limit ({self.rate} events/s) exceeded; event dropped")
            self._tokens -= 1
            self.last_remote = {"at": time.time(), "client": s.remote, "kind": s.kind}
        if not s.started:
            s.started = True
            self.log.info("input session from %s (%s) started", s.remote, s.kind)
            last = self._announced.get(s.remote, -ANNOUNCE_EVERY_SECONDS)
            if time.monotonic() - last >= ANNOUNCE_EVERY_SECONDS:
                self._announced[s.remote] = time.monotonic()
                if self.on_session:
                    try:
                        await self.on_session(s.remote)
                    except Exception as e:  # noqa: BLE001
                        self.log.warning("input session callback failed: %s", e)

    # ---- primitives ----

    async def key(self, s: Session, code: int, down: bool) -> None:
        if not down and code not in s.keys:
            return
        await self._begin(s, releasing=not down)
        if not self.enabled:
            return
        b = await self._get_backend()
        b.key(code, down)
        b.frame()
        (s.keys.add if down else s.keys.discard)(code)

    async def button(self, s: Session, code: int, down: bool) -> None:
        if not down and code not in s.buttons:
            return
        await self._begin(s, releasing=not down)
        if not self.enabled:
            return
        b = await self._get_backend()
        b.button(code, down)
        b.frame()
        (s.buttons.add if down else s.buttons.discard)(code)

    async def move_abs(self, s: Session, x: float, y: float, pixels: bool = False) -> tuple[float, float]:
        await self._begin(s)
        if not pixels:
            w, h = await self.focus_size()
            x, y = min(w - 1.0, max(0.0, x) * w), min(h - 1.0, max(0.0, y) * h)
        b = await self._get_backend()
        b.move_abs(x, y)
        b.frame()
        return x, y

    async def move_rel(self, s: Session, dx: float, dy: float) -> None:
        await self._begin(s)
        b = await self._get_backend()
        b.move_rel(dx, dy)
        b.frame()

    async def wheel(self, s: Session, dx: int, dy: int) -> None:
        await self._begin(s)
        b = await self._get_backend()
        b.scroll(max(-MAX_WHEEL, min(MAX_WHEEL, dx)), max(-MAX_WHEEL, min(MAX_WHEEL, dy)))
        b.frame()

    async def text(self, s: Session, text: str, delay_ms: float = 10) -> int:
        if len(text) > MAX_TEXT:
            raise ValueError(f"text longer than {MAX_TEXT} characters")
        keys = keymap.text_keys(text)
        for i, (code, shift) in enumerate(keys):
            if i and delay_ms > 0:
                await asyncio.sleep(delay_ms / 1000)
            if shift:
                await self.key(s, keymap.SHIFT, True)
            await self.key(s, code, True)
            await self.key(s, code, False)
            if shift:
                await self.key(s, keymap.SHIFT, False)
        return len(keys)

    async def gamepad(self, s: Session, values: dict[tuple[int, int], int], pad_id: str | None = None) -> bool:
        """Apply pad state to pad_id, or to the implicit auto pad (created on demand, removed after
        pad_idle). Returns True if the auto pad was just created (Steam needs ~1 s to open it)."""
        if pad_id is not None and pad_id != AUTO_PAD and pad_id not in self._pads:
            raise ValueError(f"unknown virtual gamepad {pad_id!r}; have {', '.join(self._pads) or 'none'}")
        await self._begin(s)
        created = False
        pad = self._pads.get(pad_id or AUTO_PAD)
        if pad is None:
            pad = self._create_pad(AUTO_PAD, "Auto pad", auto=True)
            created = True
        pad.last_used = time.monotonic()
        pad.last_event_at = time.time()
        if pad.auto and (self._pad_task is None or self._pad_task.done()):
            self._pad_task = asyncio.create_task(self._pad_reaper())
        s.used_pads.add(pad.id)
        pad.dev.apply(values)
        return created

    async def _pad_reaper(self) -> None:
        while (pad := self._pads.get(AUTO_PAD)) is not None:
            wait = pad.last_used + self.pad_idle - time.monotonic()
            if wait <= 0:
                self._close_pad(AUTO_PAD)
                return
            await asyncio.sleep(min(wait, 5.0))

    # ---- WebSocket messages ----

    async def handle(self, s: Session, msg: Any) -> None:
        if not isinstance(msg, dict):
            raise ValueError("expected a JSON object")
        kind = msg.get("type")
        if kind == "key":
            down = _bool("down", msg.get("down"))
            if "code" in msg:
                code = keymap.key_code(msg["code"])
            elif "key" in msg:
                code = keymap.key_code(msg["key"])
            else:
                raise ValueError("key needs 'code' (evdev number) or 'key' (KeyboardEvent.code)")
            await self.key(s, code, down)
        elif kind == "text":
            text = msg.get("text")
            if not isinstance(text, str):
                raise ValueError("text must be a string")
            await self.text(s, text, delay_ms=5)
        elif kind == "mouse_move":
            if "x" in msg or "y" in msg:
                await self.move_abs(s, _number("x", msg.get("x")), _number("y", msg.get("y")))
            elif "dx" in msg or "dy" in msg:
                await self.move_rel(s, _number("dx", msg.get("dx", 0)), _number("dy", msg.get("dy", 0)))
            else:
                raise ValueError("mouse_move needs x/y (0..1) or dx/dy")
        elif kind == "mouse_button":
            await self.button(s, mouse_button(msg.get("button", "left")), _bool("down", msg.get("down")))
        elif kind == "wheel":
            dx, dy = int(_number("dx", msg.get("dx", 0))), int(_number("dy", msg.get("dy", 0)))
            if dx or dy:
                await self.wheel(s, dx, dy)
        elif kind == "gamepad":
            pad_id = msg.get("pad")
            if pad_id is not None and not isinstance(pad_id, str):
                raise ValueError("pad must be a virtual gamepad id")
            values = pad_values(msg.get("buttons"), msg.get("axes"), msg.get("hat"))
            if values:
                await self.gamepad(s, values, pad_id)
        elif kind == "release_all":
            await self.release(s)
        else:
            raise ValueError(f"unknown message type {kind!r}")
