"""Controller list: Steam Input's own view (via the Steam UI's ControllerStore) merged with evdev detail,
plus creation of virtual pads that Steam Input must confirm."""
import asyncio
import json
import logging
import re
import time
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Awaitable, Callable

from ..steam import cdp
from .service import InputService, InputUnavailable, VirtualPad

if TYPE_CHECKING:
    from ..server.events import EventHub

DEVICES_PATH = "/proc/bus/input/devices"
BTN_GAMEPAD = 0x130
STEAM_TIMEOUT = 2.0
STEAM_CONFIRM_SECONDS = 3.0
POLL_SECONDS = 1.0
STEAM_POLL_SECONDS = 3.0
GHOST_SECONDS = 5.0
X360 = ("045e", "028e")
# Steam Input's own output devices ("Microsoft X-Box 360 pad N"): what games see, not an input to Steam.
STEAM_OUTPUT = ("28de", "11ff")

# window.ControllerStore is the Steam UI's MobX mirror of the Steam Input service: Init() subscribes to
# RegisterForNotifyControllerListChanged and DoControllerListQuery() fills m_controllerList. On this
# build SteamClient.Input has no GetControllerInfo/RegisterForControllerListChanges, so this is the way in.
STEAM_JS = """(() => {
  const cs = window.ControllerStore;
  if (!cs || typeof cs.GetControllers !== 'function') return null;
  const L = (s) => { try { return (s && s[0] === '#' && window.LocalizationManager?.LocalizeString(s)) || s; } catch (e) { return s; } };
  return {
    active: cs.m_nLastValidActiveControllerIndex ?? null,
    controllers: cs.GetControllers().map(c => ({
      index: c.nControllerIndex, xinput: c.nXInputIndex, type_id: c.eControllerType,
      type: cs.GetControllerTypeString(c.eControllerType) || String(c.eControllerType),
      type_name: L('#' + (cs.GetControllerTypeString(c.eControllerType) || '')),
      name: L(c.strName), vendor: c.unVendorID, product: c.unProductID, serial: c.strSerialNumber,
      wireless: !!c.bWireless, bluetooth: !!c.bBluetooth, remote: !!c.bRemoteDevice,
      battery: c.ucBatteryLevel ?? null,
    })),
  };
})()"""

ReadDevices = Callable[[], str]
SteamQuery = Callable[[], Awaitable[dict[str, Any] | None]]


@dataclass
class EvdevDevice:
    name: str
    vendor: str
    product: str
    sysfs: str
    handlers: list[str]
    keys: set[int]

    @property
    def sysname(self) -> str:
        return self.sysfs.rstrip("/").rsplit("/", 1)[-1]

    @property
    def event(self) -> str | None:
        return next((f"/dev/input/{h}" for h in self.handlers if re.fullmatch(r"event\d+", h)), None)

    @property
    def is_gamepad(self) -> bool:
        return BTN_GAMEPAD in self.keys

    @property
    def virtual(self) -> bool:
        return "/virtual/" in self.sysfs

    @property
    def number(self) -> int:
        m = re.search(r"(\d+)$", self.sysname)
        return int(m.group(1)) if m else 0


def parse_bitmap(text: str) -> set[int]:
    """A /proc/bus/input/devices bitmap: hex words of 64 bits, most significant word first."""
    bits: set[int] = set()
    for i, word in enumerate(reversed(text.split())):
        v = int(word, 16)
        base = i * 64
        while v:
            low = v & -v
            bits.add(base + low.bit_length() - 1)
            v ^= low
    return bits


def parse_devices(text: str) -> list[EvdevDevice]:
    out: list[EvdevDevice] = []
    for block in text.split("\n\n"):
        fields: dict[str, str] = {}
        name = vendor = product = sysfs = ""
        for line in block.splitlines():
            if line.startswith("I:"):
                ids = dict(kv.split("=", 1) for kv in line[2:].split() if "=" in kv)
                vendor, product = ids.get("Vendor", "").lower(), ids.get("Product", "").lower()
            elif line.startswith("N: Name="):
                name = line[len("N: Name="):].strip().strip('"')
            elif line.startswith("S: Sysfs="):
                sysfs = line[len("S: Sysfs="):].strip()
            elif line.startswith("H: Handlers="):
                fields["H"] = line[len("H: Handlers="):]
            elif line.startswith("B: KEY="):
                fields["KEY"] = line[len("B: KEY="):]
        if not sysfs:
            continue
        out.append(EvdevDevice(name, vendor, product, sysfs, fields.get("H", "").split(),
                               parse_bitmap(fields.get("KEY", ""))))
    return out


def evdev_gamepads(text: str) -> list[EvdevDevice]:
    return sorted((d for d in parse_devices(text) if d.is_gamepad and (d.vendor, d.product) != STEAM_OUTPUT),
                  key=lambda d: d.number)


def read_proc_devices() -> str:
    with open(DEVICES_PATH, encoding="utf-8", errors="replace") as f:
        return f.read()


async def steam_input_controllers() -> dict[str, Any] | None:
    try:
        return await asyncio.wait_for(cdp.evaluate_in(None, STEAM_JS, timeout=STEAM_TIMEOUT), STEAM_TIMEOUT)
    except (cdp.CdpError, asyncio.TimeoutError, OSError):
        return None


def _hex4(n: Any) -> str | None:
    return f"{int(n):04x}" if isinstance(n, int) and not isinstance(n, bool) and n >= 0 else None


def merge(evdev: list[EvdevDevice], steam: dict[str, Any] | None, pads: list[VirtualPad]) -> list[dict[str, Any]]:
    """Steam Input's entries first (their order), each paired with an evdev node; then evdev gamepads
    Steam Input does not list (steam: null, seen_by_steam: false)."""
    by_sysname = {p.sysname: p for p in pads if p.sysname}
    pad_dev = {p.id: next((d for d in evdev if d.sysname == p.sysname), None) for p in pads}
    used: set[str] = set()
    out: list[dict[str, Any]] = []

    def entry(dev: EvdevDevice | None, sc: dict[str, Any] | None, pad: VirtualPad | None) -> dict[str, Any]:
        if dev is not None:
            used.add(dev.sysname)
        vendor = dev.vendor if dev else _hex4(sc.get("vendor")) if sc else None
        product = dev.product if dev else _hex4(sc.get("product")) if sc else None
        virtual = pad is not None or (dev is not None and dev.virtual)
        if pad is not None:
            ident = pad.id
        elif sc is not None and sc.get("serial"):
            ident = f"steam:{sc['serial']}"
        elif sc is not None:
            ident = f"steam:{sc.get('index')}"
        else:
            ident = f"evdev:{dev.sysname}" if dev else "?"
        steam = None
        if sc is not None:
            xi = sc.get("xinput")
            steam = {"type": sc.get("type"), "slot": xi if isinstance(xi, int) and xi >= 0 else None,
                     "name": sc.get("name") or "", "index": sc.get("index"), "type_name": sc.get("type_name"),
                     "active": active is not None and sc.get("index") == active}
        return {"id": ident, "name": pad.name if pad else (sc.get("type_name") or sc.get("name")) if sc else dev.name,
                "kind": "virtual" if virtual else "physical", "virtual_id": pad.id if pad else None,
                "vendor": vendor, "product": product, "device": dev.event if dev else None,
                "evdev_name": dev.name if dev else None, "seen_by_steam": sc is not None, "steam": steam}

    active = steam.get("active") if steam else None
    steam_list = sorted((steam or {}).get("controllers") or [], key=lambda c: c.get("index", 0))
    # Pads whose Steam serial we learned when Steam confirmed them pair exactly; the rest by order.
    pending = [p for p in pads if not p.steam_serial]
    for sc in steam_list:
        vid, pid = _hex4(sc.get("vendor")), _hex4(sc.get("product"))
        pad = next((p for p in pads if p.steam_serial and p.steam_serial == sc.get("serial")), None)
        if pad is None and (vid, pid) == X360 and pending:
            pad = pending.pop(0)
        if pad is not None:
            dev = pad_dev.get(pad.id)
        else:
            dev = next((d for d in evdev if d.sysname not in used and d.sysname not in by_sysname
                        and (d.vendor, d.product) == (vid, pid)), None)
        out.append(entry(dev, sc, pad))
    for dev in evdev:
        if dev.sysname not in used:
            out.append(entry(dev, None, by_sysname.get(dev.sysname)))
    return out


class ControllerService:
    def __init__(self, input_service: InputService, logger: logging.Logger, *,
                 read_devices: ReadDevices = read_proc_devices, steam_query: SteamQuery = steam_input_controllers,
                 poll: float = POLL_SECONDS, steam_poll: float = STEAM_POLL_SECONDS,
                 confirm_seconds: float = STEAM_CONFIRM_SECONDS, events: "EventHub | None" = None):
        self.input = input_service
        self.log = logger
        self._read_devices = read_devices
        self._steam_query = steam_query
        self.poll = poll
        self.steam_poll = steam_poll
        self.confirm_seconds = confirm_seconds
        self.events = events
        self._task: asyncio.Task[None] | None = None
        self._wake = asyncio.Event()
        self._lock = asyncio.Lock()
        self._gone: dict[str, float] = {}
        input_service.add_pad_listener(self._wake.set)
        if events is not None:
            # Watching costs a /proc read a second and a Steam UI query every few; only while someone listens.
            events.on_subscribe.append(self._watch)

    def _evdev(self) -> list[EvdevDevice]:
        try:
            return evdev_gamepads(self._read_devices())
        except OSError as e:
            self.log.warning("reading %s failed: %s", DEVICES_PATH, e)
            return []

    async def snapshot(self, steam: dict[str, Any] | None | bool = True) -> dict[str, Any]:
        if steam is True:
            steam = await self._steam_query()
        pads = self.input.pads()
        if steam and self._gone:
            # Steam Input keeps listing a removed pad for a second or two; hide it rather than show a ghost.
            now = time.monotonic()
            self._gone = {k: t for k, t in self._gone.items() if t > now}
            steam = {**steam, "controllers": [c for c in steam.get("controllers") or [] if c.get("serial") not in self._gone]}
        return {"controllers": merge(self._evdev(), steam or None, pads), "virtual": [p.info() for p in pads],
                "input_enabled": self.input.enabled, "steam_available": bool(steam)}

    async def add_virtual(self, name: Any = None) -> dict[str, Any]:
        async with self._lock:
            before = await self._steam_query()
            if before is None:
                raise InputUnavailable("Steam Input is not reachable (Steam UI / CEF debugger down), so a new pad "
                                       "could not be confirmed; not creating one")
            loop = asyncio.get_running_loop()
            # Steam reuses serials, so let a just-removed pad drop out of its list first; otherwise the new
            # pad could never look new.
            deadline = loop.time() + self.confirm_seconds
            while (before and loop.time() < deadline
                   and any(c.get("serial") in self._gone for c in before.get("controllers") or [])):
                await asyncio.sleep(0.25)
                before = await self._steam_query()
            if before is None:
                raise InputUnavailable("Steam Input is not reachable; not creating a pad")
            known = {c.get("serial") for c in before.get("controllers") or []}
            pad = self.input.add_pad(name)
            deadline = loop.time() + self.confirm_seconds
            while True:
                await asyncio.sleep(0.25)
                now = await self._steam_query()
                fresh = [c for c in (now or {}).get("controllers") or []
                         if c.get("serial") not in known and (_hex4(c.get("vendor")), _hex4(c.get("product"))) == X360]
                if fresh:
                    pad.steam_serial = fresh[0].get("serial")
                    self._gone.pop(pad.steam_serial, None)
                    self.log.info("Steam Input lists virtual pad %s as controller %s", pad.id, fresh[0].get("index"))
                    self._wake.set()
                    return {"id": pad.id, "name": pad.name, "type": pad.type}
                if loop.time() >= deadline:
                    self.input.remove_pad(pad.id)
                    raise InputUnavailable(f"Steam Input did not list the new virtual pad within "
                                           f"{self.confirm_seconds:g} s; removed it")

    def remove_virtual(self, pad_id: str) -> bool:
        pad = self.input.get_pad(pad_id)
        if pad is not None and pad.steam_serial:
            self._gone[pad.steam_serial] = time.monotonic() + GHOST_SECONDS
        return self.input.remove_pad(pad_id)

    # ---- change events ----

    @staticmethod
    def event(snap: dict[str, Any]) -> dict[str, Any]:
        return {"controllers": snap["controllers"], "virtual": snap["virtual"]}

    def _watch(self) -> None:
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._run())

    async def _run(self) -> None:
        loop = asyncio.get_running_loop()
        last_evdev: list[tuple[str, str]] | None = None
        last_emitted: str | None = None
        steam: dict[str, Any] | None = None
        steam_at = -1e9
        while self.events is not None and len(self.events):
            evdev = [(d.sysname, d.name) for d in self._evdev()]
            changed = evdev != last_evdev or self._wake.is_set()
            self._wake.clear()
            if changed or loop.time() - steam_at >= self.steam_poll:
                steam = await self._steam_query()
                steam_at = loop.time()
            last_evdev = evdev
            snap = await self.snapshot(steam)
            # last_event_at moves with every gamepad event; that alone is not a list change.
            key = json.dumps({"c": snap["controllers"], "v": [{**v, "last_event_at": None} for v in snap["virtual"]]},
                             sort_keys=True, default=str)
            if key != last_emitted:
                self.events.publish("controllers", self.event(snap))
            last_emitted = key
            try:
                await asyncio.wait_for(self._wake.wait(), self.poll)
            except asyncio.TimeoutError:
                pass
