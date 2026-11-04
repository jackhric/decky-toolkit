"""libei sender over ctypes: injects input through gamescope's own EIS server ($XDG_RUNTIME_DIR/gamescope-N-ei).

gamescope exposes one "Gamescope Virtual Input" device with relative and absolute pointer, buttons,
scroll and keyboard. Absolute coordinates are in the focused window's pixels (clamped to its size).
"""
import asyncio
import ctypes
import logging
import os

SOCKET_NAMES = ("gamescope-0-ei", "gamescope-1-ei")

EVENT_CONNECT, EVENT_DISCONNECT, EVENT_SEAT_ADDED, EVENT_SEAT_REMOVED = 1, 2, 3, 4
EVENT_DEVICE_ADDED, EVENT_DEVICE_REMOVED, EVENT_DEVICE_PAUSED, EVENT_DEVICE_RESUMED = 5, 6, 7, 8
CAP_POINTER, CAP_POINTER_ABSOLUTE, CAP_KEYBOARD, CAP_TOUCH, CAP_SCROLL, CAP_BUTTON = 1, 2, 4, 8, 16, 32

_P = ctypes.c_void_p
_SIGNATURES = [
    ("ei_new_sender", _P, [_P]),
    ("ei_configure_name", None, [_P, ctypes.c_char_p]),
    ("ei_setup_backend_socket", ctypes.c_int, [_P, ctypes.c_char_p]),
    ("ei_get_fd", ctypes.c_int, [_P]),
    ("ei_dispatch", None, [_P]),
    ("ei_get_event", _P, [_P]),
    ("ei_now", ctypes.c_uint64, [_P]),
    ("ei_unref", _P, [_P]),
    ("ei_event_get_type", ctypes.c_int, [_P]),
    ("ei_event_get_seat", _P, [_P]),
    ("ei_event_get_device", _P, [_P]),
    ("ei_event_unref", _P, [_P]),
    ("ei_device_ref", _P, [_P]),
    ("ei_device_unref", _P, [_P]),
    ("ei_device_get_name", ctypes.c_char_p, [_P]),
    ("ei_device_has_capability", ctypes.c_bool, [_P, ctypes.c_int]),
    ("ei_device_start_emulating", None, [_P, ctypes.c_uint32]),
    ("ei_device_stop_emulating", None, [_P]),
    ("ei_device_frame", None, [_P, ctypes.c_uint64]),
    ("ei_device_pointer_motion", None, [_P, ctypes.c_double, ctypes.c_double]),
    ("ei_device_pointer_motion_absolute", None, [_P, ctypes.c_double, ctypes.c_double]),
    ("ei_device_button_button", None, [_P, ctypes.c_uint32, ctypes.c_bool]),
    ("ei_device_scroll_discrete", None, [_P, ctypes.c_int32, ctypes.c_int32]),
    ("ei_device_keyboard_key", None, [_P, ctypes.c_uint32, ctypes.c_bool]),
]
_lib = None


class EiError(RuntimeError):
    pass


def _load():
    global _lib
    if _lib is None:
        try:
            lib = ctypes.CDLL("libei.so.1")
        except OSError as e:
            raise EiError(f"libei.so.1 not loadable: {e}") from None
        for name, res, args in _SIGNATURES:
            fn = getattr(lib, name)
            fn.restype = res
            fn.argtypes = args
        # Variadic, NULL-terminated: leave argtypes unset and pass c_int explicitly.
        lib.ei_seat_bind_capabilities.restype = None
        _lib = lib
    return _lib


def find_socket(runtime_dir: str) -> str | None:
    for name in SOCKET_NAMES:
        path = os.path.join(runtime_dir, name)
        if os.path.exists(path):
            return path
    return None


class EiSender:
    """One long-lived connection; every gamescope_ei connect logs a warning there, so reuse it."""

    def __init__(self, socket_path: str, logger: logging.Logger):
        self.path = socket_path
        self.log = logger
        self._ei: int | None = None
        self._dev: int | None = None
        self._ino: int | None = None
        self._fd = -1
        self._seq = 0
        self._loop: asyncio.AbstractEventLoop | None = None
        self._ready: asyncio.Event | None = None

    @property
    def connected(self) -> bool:
        return self._ei is not None and self._dev is not None

    def _socket_changed(self) -> bool:
        try:
            return os.stat(self.path).st_ino != self._ino
        except OSError:
            return True

    async def ensure(self, timeout: float = 2.0) -> None:
        """Connect (or reconnect after a gamescope restart) and wait for the resumed device."""
        if self.connected and not self._socket_changed():
            return
        self.close()
        lib = _load()
        try:
            self._ino = os.stat(self.path).st_ino
        except OSError:
            raise EiError(f"{self.path} does not exist") from None
        ei = lib.ei_new_sender(None)
        if not ei:
            raise EiError("ei_new_sender failed")
        lib.ei_configure_name(ei, b"decky-mcp")
        rc = lib.ei_setup_backend_socket(ei, self.path.encode())
        if rc != 0:
            lib.ei_unref(ei)
            raise EiError(f"connecting to {self.path} failed: {os.strerror(-rc)}")
        self._ei = ei
        self._fd = lib.ei_get_fd(ei)
        self._loop = asyncio.get_running_loop()
        self._ready = asyncio.Event()
        self._loop.add_reader(self._fd, self._dispatch)
        self._dispatch()
        try:
            await asyncio.wait_for(self._ready.wait(), timeout)
        except asyncio.TimeoutError:
            self.close()
            raise EiError(f"no input device from {self.path} within {timeout}s") from None
        self.log.info("libei connected to %s", self.path)

    def _dispatch(self) -> None:
        lib = _lib
        if lib is None or self._ei is None:
            return
        lib.ei_dispatch(self._ei)
        while self._ei is not None and (ev := lib.ei_get_event(self._ei)):
            try:
                self._handle(lib, ev, lib.ei_event_get_type(ev))
            finally:
                lib.ei_event_unref(ev)

    def _handle(self, lib, ev: int, kind: int) -> None:
        if kind == EVENT_SEAT_ADDED:
            lib.ei_seat_bind_capabilities(
                ctypes.c_void_p(lib.ei_event_get_seat(ev)), ctypes.c_int(CAP_POINTER), ctypes.c_int(CAP_POINTER_ABSOLUTE),
                ctypes.c_int(CAP_BUTTON), ctypes.c_int(CAP_SCROLL), ctypes.c_int(CAP_KEYBOARD), ctypes.c_int(0))
        elif kind == EVENT_DEVICE_RESUMED:
            dev = lib.ei_event_get_device(ev)
            if self._dev is None and lib.ei_device_has_capability(dev, CAP_POINTER_ABSOLUTE):
                self._dev = lib.ei_device_ref(dev)
                self._seq += 1
                lib.ei_device_start_emulating(self._dev, self._seq)
                if self._ready:
                    self._ready.set()
        elif kind in (EVENT_DEVICE_PAUSED, EVENT_DEVICE_REMOVED):
            dev = lib.ei_event_get_device(ev)
            if self._dev is not None and dev == self._dev:
                lib.ei_device_unref(self._dev)
                self._dev = None
        elif kind == EVENT_DISCONNECT:
            self.log.info("libei disconnected from %s", self.path)
            # Tear down after this dispatch round; unref'ing the context inside its own loop is unsafe.
            if self._loop:
                self._loop.call_soon(self.close)

    def _device(self) -> int:
        if self._dev is None:
            raise EiError("libei device not connected")
        return self._dev

    def move_abs(self, x: float, y: float) -> None:
        _lib.ei_device_pointer_motion_absolute(self._device(), x, y)

    def move_rel(self, dx: float, dy: float) -> None:
        _lib.ei_device_pointer_motion(self._device(), dx, dy)

    def button(self, code: int, down: bool) -> None:
        _lib.ei_device_button_button(self._device(), code, down)

    def scroll(self, dx: int, dy: int) -> None:
        _lib.ei_device_scroll_discrete(self._device(), int(dx) * 120, int(dy) * 120)

    def key(self, code: int, down: bool) -> None:
        _lib.ei_device_keyboard_key(self._device(), code, down)

    def frame(self) -> None:
        dev = self._device()
        _lib.ei_device_frame(dev, _lib.ei_now(self._ei))
        # Flushes the queued requests to the socket.
        _lib.ei_dispatch(self._ei)

    def close(self) -> None:
        lib = _lib
        if self._loop and self._fd >= 0:
            try:
                self._loop.remove_reader(self._fd)
            except (ValueError, RuntimeError):
                pass
        self._fd = -1
        if lib is None:
            return
        if self._dev is not None:
            try:
                lib.ei_device_stop_emulating(self._dev)
            finally:
                lib.ei_device_unref(self._dev)
                self._dev = None
        if self._ei is not None:
            lib.ei_unref(self._ei)
            self._ei = None

