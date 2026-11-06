"""Steam's performance overlay (MangoHud), set the way the Quick Access performance tab does it.

Steam's SystemPerfStore.SetPerfOverlayLevel builds a CMsgSystemPerfUpdateSettings for the active profile's game
and passes it base64-encoded to SteamClient.System.Perf.UpdateSettings. The store only exists once the Performance
tab was opened, so we encode the same message ourselves. Field numbers are from the message definitions in Steam's
webpack bundle (verified 2026-11-04, client 1792618285):
  CMsgSystemPerfState: 1 limits, 2 settings, 3 current_game_id (uint64), 4 active_profile_game_id (uint64)
  CMsgSystemPerfLimits: 7 perf_overlay_is_standalone (bool)
  CMsgSystemPerfSettings: 1 global, 2 per_app
  CMsgSystemPerfSettingsGlobal: 4 perf_overlay_service_state (0 unavailable, 1 disabled, 2 enabled),
    5 perf_overlay_level (enum), 6 is_show_perf_overlay_over_steam_enabled (bool)
  CMsgSystemPerfUpdateSettings: 1 gameid (uint64), 2 reset_to_default, 3 settings_delta, 4 skip_storage_update
Unless the overlay is standalone (then the tab shows only the slider, as on the test device), the tab also has an
on/off toggle for the service state, so a level above 0 enables the service as well; level 0 leaves it alone.
"""
import asyncio
import base64
import json
from typing import Any, Awaitable, Callable

from ..steam import cdp
from . import ToolRegistry

Evaluate = Callable[[str], Awaitable[Any]]
# Quick Access slider position -> EGraphicsPerfOverlayLevel (0 hidden, 1 basic, 2 medium, 3 full, 4 minimal).
LEVELS = {0: 0, 1: 4, 2: 1, 3: 2, 4: 3}
LEVEL_NAMES = {0: "off", 1: "fps only", 2: "basic", 3: "medium", 4: "full"}
F_SERVICE, F_OVERLAY_LEVEL, F_OVER_STEAM = 4, 5, 6
SERVICE_ENABLED = 2
F_STANDALONE = 7

_STATE_JS = """(async () => {
  const m = await new Promise((res) => { let h = null, done = false;
    const fin = (x) => { if (done) return; done = true; setTimeout(() => { try { h && h.unregister(); } catch (e) {} }, 0); res(x); };
    setTimeout(() => fin(null), 3000);
    h = SteamClient.System.Perf.RegisterForStateChanges(fin); });
  return m ? btoa(String.fromCharCode(...new Uint8Array(m))) : null; })()"""


def varint(n: int) -> bytes:
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        out.append(b | (0x80 if n else 0))
        if not n:
            return bytes(out)


def decode(buf: bytes) -> dict[int, list[Any]]:
    """Protobuf wire format to {field: [values]}: varints as int, length-delimited as bytes."""
    out: dict[int, list[Any]] = {}
    i = 0

    def read_varint() -> int:
        nonlocal i
        shift = n = 0
        while True:
            b = buf[i]
            i += 1
            n |= (b & 0x7F) << shift
            shift += 7
            if not b & 0x80:
                return n

    while i < len(buf):
        key = read_varint()
        field, wire = key >> 3, key & 7
        if wire == 0:
            val: Any = read_varint()
        elif wire == 2:
            size = read_varint()
            val = buf[i:i + size]
            i += size
        elif wire == 5:
            val = buf[i:i + 4]
            i += 4
        elif wire == 1:
            val = buf[i:i + 8]
            i += 8
        else:
            raise ValueError(f"unsupported wire type {wire}")
        out.setdefault(field, []).append(val)
    return out


def _len_field(field: int, payload: bytes) -> bytes:
    return varint(field << 3 | 2) + varint(len(payload)) + payload


def update_message(gameid: int, global_fields: dict[int, int]) -> bytes:
    glob = b"".join(varint(f << 3) + varint(v) for f, v in global_fields.items())
    return varint(1 << 3) + varint(gameid) + _len_field(3, _len_field(1, glob))


def parse_state(raw: bytes) -> dict[str, Any]:
    state = decode(raw)
    settings = decode(state.get(2, [b""])[0])
    glob = decode(settings.get(1, [b""])[0])
    value = glob.get(F_OVERLAY_LEVEL, [0])[0]
    level = {v: k for k, v in LEVELS.items()}.get(value)
    service = glob.get(F_SERVICE, [0])[0]
    limits = decode(state.get(1, [b""])[0])
    return {
        "enabled": service == SERVICE_ENABLED,
        "available": service != 0,
        "standalone": bool(limits.get(F_STANDALONE, [0])[0]),
        "level": level,
        "level_name": LEVEL_NAMES.get(level, f"unknown ({value})") if level is not None else f"unknown ({value})",
        "steam_value": value,
        "show_over_steam": bool(glob.get(F_OVER_STEAM, [0])[0]),
        "current_game_id": str(state.get(3, [0])[0]),
        "active_profile_game_id": str(state.get(4, [0])[0]),
    }


def check_level(level: Any) -> int:
    if isinstance(level, bool) or not isinstance(level, int) or level not in LEVELS:
        raise ValueError("level must be an integer 0-4 (0 off, 1 fps only, 2 basic, 3 medium, 4 full), "
                         "as on the Quick Access performance tab")
    return level


class PerfOverlay:
    def __init__(self, evaluate: Evaluate | None = None) -> None:
        self._eval = evaluate or (lambda js: cdp.evaluate_in(None, js))

    async def _raw_state(self) -> bytes:
        b64 = await self._eval(_STATE_JS)
        if not b64:
            raise cdp.CdpError("Steam did not report its performance state (SteamClient.System.Perf)")
        return base64.b64decode(b64)

    async def status(self) -> dict[str, Any]:
        return parse_state(await self._raw_state())

    async def set(self, level: int, show_over_steam: bool | None = None) -> dict[str, Any]:
        check_level(level)
        if show_over_steam is not None and not isinstance(show_over_steam, bool):
            raise ValueError("show_over_steam must be true or false")
        raw = await self._raw_state()
        current = parse_state(raw)
        if not current["available"] and not current["standalone"]:
            raise ValueError("Steam reports the performance overlay as unavailable on this device")
        gameid = int(decode(raw).get(4, [0])[0])
        fields = {F_OVERLAY_LEVEL: LEVELS[level]}
        if level and not current["enabled"] and not current["standalone"]:
            fields[F_SERVICE] = SERVICE_ENABLED
        if show_over_steam is not None:
            fields[F_OVER_STEAM] = int(show_over_steam)
        payload = base64.b64encode(update_message(gameid, fields)).decode()
        await self._eval(f"SteamClient.System.Perf.UpdateSettings({json.dumps(payload)}), true")
        for _ in range(10):
            await asyncio.sleep(0.2)
            now = await self.status()
            if now["steam_value"] == LEVELS[level]:
                return now
        return {**now, "warning": "Steam did not report the new level within 2 s"}


def register(reg: ToolRegistry, overlay: PerfOverlay | None = None) -> None:
    perf = overlay or PerfOverlay()

    @reg.add(
        "perf_overlay",
        "Set Steam's performance overlay (MangoHud) level like the Quick Access performance tab: 0 off, 1 fps only, "
        "2 basic, 3 medium, 4 full. It draws over games; show_over_steam=true also draws it over the Steam UI. "
        "Note: mangoapp is a gamescope external overlay, which gamescope does not paint into its PipeWire stream, so "
        "screen_capture and recordings never show it; check the level with perf_overlay_status or the Quick Access "
        "performance tab (ui_navigate action=quick_access tab=perf capture=true). Returns the new status.",
        {"properties": {"level": {"type": "integer", "minimum": 0, "maximum": 4},
                        "show_over_steam": {"type": "boolean"}},
         "required": ["level"]},
    )
    async def perf_overlay(level: int, show_over_steam: bool | None = None) -> dict[str, Any]:
        return await perf.set(level, show_over_steam)

    @reg.add(
        "perf_overlay_status",
        "Steam's performance overlay level (0-4 as on the Quick Access tab), service state (enabled/available/"
        "standalone), whether it shows over the Steam UI, and the game ids of Steam's current game and active "
        "performance profile.",
    )
    async def perf_overlay_status() -> dict[str, Any]:
        return await perf.status()
