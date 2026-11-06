"""When someone last touched the device itself: reads every physical evdev device without grabbing it.

Only the time and the device are kept, never what was pressed. Virtual devices (our uinput pads, Steam's
per-controller mirrors, steamos-manager) live under /devices/virtual and are skipped, as are accelerometers (a gyro
never stops reporting) and devices without keys or axes (lid and jack switches, the PC speaker).
"""
import asyncio
import logging
import os
import time
from typing import Any

INPUT_DIR = "/dev/input"
SYS_INPUT = "/sys/class/input"
RESCAN_SECONDS = 5.0
EV_KEY, EV_REL, EV_ABS = 1, 2, 3
INPUT_PROP_ACCELEROMETER = 6
AT_DEVICE_SECONDS = 60


def _read(path: str) -> str:
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return ""


def _bits(hexwords: str) -> int:
    # sysfs prints the bitmap as space-separated hex words, most significant first.
    value = 0
    for word in hexwords.split():
        value = (value << 64) | int(word, 16)
    return value


def describe(event: str, sys_input: str = SYS_INPUT) -> dict[str, Any] | None:
    """Name and ids of `eventN`, or None when it is not a physical input a person operates."""
    dev = os.path.join(sys_input, event, "device")
    if "/devices/virtual/" in os.path.realpath(dev):
        return None
    ev = _bits(_read(os.path.join(dev, "capabilities", "ev")) or "0")
    if not ev & ((1 << EV_KEY) | (1 << EV_REL) | (1 << EV_ABS)):
        return None
    if _bits(_read(os.path.join(dev, "properties")) or "0") & (1 << INPUT_PROP_ACCELEROMETER):
        return None
    vendor, product = _read(os.path.join(dev, "id", "vendor")), _read(os.path.join(dev, "id", "product"))
    return {"name": _read(os.path.join(dev, "name")) or event, "id": f"{vendor}:{product}"}


def someone_at_device(snapshot: dict[str, Any], within: float = AT_DEVICE_SECONDS) -> bool:
    """Physical input within the last `within` seconds, from an `InputActivity.snapshot()`."""
    last = snapshot["last"]
    return bool(last and last["seconds_ago"] <= within)


class InputActivity:
    def __init__(self, log: logging.Logger, input_dir: str = INPUT_DIR, sys_input: str = SYS_INPUT):
        self.log, self.input_dir, self.sys_input = log, input_dir, sys_input
        self._open: dict[str, tuple[int, dict[str, Any]]] = {}
        self._last: dict[str, float] = {}
        self._task: asyncio.Task | None = None

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._scan_loop(), name="input-activity")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)
            self._task = None
        for event in list(self._open):
            self._close(event)

    async def _scan_loop(self) -> None:
        while True:
            self.scan()
            await asyncio.sleep(RESCAN_SECONDS)

    def scan(self) -> None:
        try:
            present = {e for e in os.listdir(self.input_dir) if e.startswith("event")}
        except OSError:
            present = set()
        for event in set(self._open) - present:
            self._close(event)
        loop = asyncio.get_running_loop()
        for event in sorted(present - set(self._open)):
            info = describe(event, self.sys_input)
            if info is None:
                continue
            try:
                fd = os.open(os.path.join(self.input_dir, event), os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC)
            except OSError as e:
                self.log.debug("input activity: cannot open %s: %s", event, e)
                continue
            self._open[event] = (fd, info)
            loop.add_reader(fd, self._on_readable, event)

    def _on_readable(self, event: str) -> None:
        fd, _ = self._open.get(event, (None, None))
        if fd is None:
            return
        try:
            while os.read(fd, 4096):
                self._last[event] = time.time()
        except BlockingIOError:
            pass
        except OSError:  # unplugged
            self._close(event)

    def _close(self, event: str) -> None:
        fd, _ = self._open.pop(event, (None, None))
        if fd is not None:
            try:
                asyncio.get_running_loop().remove_reader(fd)
            except RuntimeError:
                pass
            os.close(fd)

    def snapshot(self) -> dict[str, Any]:
        now = time.time()
        devices = []
        for event, (_, info) in sorted(self._open.items()):
            at = self._last.get(event)
            devices.append({**info, "event": event, "seconds_ago": round(now - at, 1) if at else None})
        last_event = max(self._last, key=self._last.get, default=None)
        last = None
        if last_event:
            name = self._open.get(last_event, (None, {"name": last_event}))[1]["name"]
            last = {"device": name, "at": self._last[last_event], "seconds_ago": round(now - self._last[last_event], 1)}
        return {"devices": devices, "last": last}
