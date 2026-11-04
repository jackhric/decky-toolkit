"""Performance overlay: protobuf encoding, argument validation and the Steam call. Run with: ./scripts/test.sh"""
import asyncio
import base64
import json
import re
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "py_modules"))

from decky_mcp.tools import ToolRegistry  # noqa: E402
from decky_mcp.tools import perf  # noqa: E402
from decky_mcp.tools.perf import PerfOverlay, check_level, decode, parse_state, update_message, varint  # noqa: E402

# CMsgSystemPerfState captured on the test device (standalone overlay, level off, global profile 769).
DEVICE_STATE = ("ClEI6AcQrBsYACAFOAFIAFgAYABoD2geaDxoAHADeA+YASigATyoAQ+oAR6oATyoAQC4AQHAAQDQAQPQAQLQAQHYAQHYAQLYAQPYAQTYAQXw"
                "AQESOQoVDQAAgD8YASABKAAwAGABtQEGgZU+EiAQPCgPMAE43AtIBVAAWABgAJABPKABALgBAMABAcgBARi+3ZwBIIEG")


def state(level_value: int = 0, service: int = 1, standalone: bool = False, gameid: int = 769) -> bytes:
    glob = varint(4 << 3) + varint(service) + varint(5 << 3) + varint(level_value)
    settings = varint(1 << 3 | 2) + varint(len(glob)) + glob
    limits = varint(7 << 3) + varint(int(standalone))
    return (varint(1 << 3 | 2) + varint(len(limits)) + limits + varint(2 << 3 | 2) + varint(len(settings)) + settings
            + varint(3 << 3) + varint(70300) + varint(4 << 3) + varint(gameid))


class FakeSteam:
    def __init__(self, **kw) -> None:
        self.kw = kw
        self.updates: list[dict[int, list]] = []

    async def __call__(self, js: str):
        if "RegisterForStateChanges" in js:
            return base64.b64encode(state(**self.kw)).decode()
        m = re.search(r'UpdateSettings\("([^"]+)"\)', js)
        assert m, js
        msg = decode(base64.b64decode(m.group(1)))
        self.updates.append(msg)
        glob = decode(decode(msg[3][0])[1][0])
        self.kw["level_value"] = glob[5][0]
        if 4 in glob:
            self.kw["service"] = glob[4][0]
        return True


def test_varint_and_decode_roundtrip():
    for n in (0, 1, 127, 128, 300, 2 ** 32, 18422061970434818048):
        assert decode(varint(1 << 3) + varint(n)) == {1: [n]}
    assert decode(varint(2 << 3 | 2) + varint(3) + b"abc") == {2: [b"abc"]}


def test_update_message_layout():
    msg = decode(update_message(769, {5: 1, 4: 2}))
    assert msg[1] == [769], "gameid is a uint64 varint, like Steam's writeUint64String"
    delta = decode(msg[3][0])
    assert decode(delta[1][0]) == {5: [1], 4: [2]}
    assert 2 not in msg, "never reset_to_default"


def test_parse_device_state():
    st = parse_state(base64.b64decode(DEVICE_STATE))
    assert st == {"enabled": False, "available": True, "standalone": True, "level": 0, "level_name": "off",
                  "steam_value": 0, "show_over_steam": False, "current_game_id": "2567870",
                  "active_profile_game_id": "769"}


def test_level_mapping():
    assert [parse_state(state(v))["level"] for v in (0, 4, 1, 2, 3)] == [0, 1, 2, 3, 4]
    assert parse_state(state(9))["level"] is None and "unknown" in parse_state(state(9))["level_name"]


@pytest.mark.parametrize("bad", [-1, 5, 2.0, "2", True, None])
def test_check_level_rejects(bad):
    with pytest.raises(ValueError):
        check_level(bad)


def test_set_standalone_only_touches_level():
    steam = FakeSteam(standalone=True)
    res = asyncio.run(PerfOverlay(steam).set(2))
    assert res["level"] == 2 and res["steam_value"] == 1
    glob = decode(decode(steam.updates[0][3][0])[1][0])
    assert glob == {5: [1]} and steam.updates[0][1] == [769]


def test_set_enables_service_with_toggle_and_level0_leaves_it():
    steam = FakeSteam(service=1, standalone=False)
    overlay = PerfOverlay(steam)
    assert asyncio.run(overlay.set(4))["enabled"] is True
    assert decode(decode(steam.updates[0][3][0])[1][0]) == {5: [3], 4: [2]}
    asyncio.run(overlay.set(0))
    assert decode(decode(steam.updates[1][3][0])[1][0]) == {5: [0]}
    asyncio.run(overlay.set(1, show_over_steam=True))
    assert decode(decode(steam.updates[2][3][0])[1][0]) == {5: [4], 6: [1]}, "already enabled: no service write"


def test_set_unavailable_refused():
    steam = FakeSteam(service=0, standalone=False)
    with pytest.raises(ValueError, match="unavailable"):
        asyncio.run(PerfOverlay(steam).set(2))
    assert steam.updates == []


def test_tool_rejects_bad_level_without_calling_steam():
    steam = FakeSteam()
    reg = ToolRegistry()
    perf.register(reg, PerfOverlay(steam))
    res = asyncio.run(reg.call("perf_overlay", {"level": 7}))
    assert res["isError"] and "0-4" in res["content"][0]["text"]
    res = asyncio.run(reg.call("perf_overlay", {"level": 2, "show_over_steam": "yes"}))
    assert res["isError"]
    assert steam.updates == []
    res = asyncio.run(reg.call("perf_overlay_status", {}))
    assert json.loads(res["content"][0]["text"])["level"] == 0
