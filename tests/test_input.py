"""Remote input: keymap, uinput structs, InputService state, /input routes and tools. Run with: ./scripts/test.sh"""
import asyncio
import json
import logging
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "py_modules"))

from aiohttp import ClientSession, ClientTimeout, WSMsgType, WSServerHandshakeError, web  # noqa: E402

from decky_toolkit.auth import TokenAuth  # noqa: E402
from decky_toolkit.http import Api  # noqa: E402
from decky_toolkit.input import keymap, uinput  # noqa: E402
from decky_toolkit.input.service import InputDisabled, InputService, InputUnavailable, pad_values  # noqa: E402
from decky_toolkit.protocol import McpServer  # noqa: E402
from decky_toolkit.settings import Settings  # noqa: E402
from decky_toolkit.tools import ToolRegistry, build_registry  # noqa: E402

TOKEN = "test-token"
H = {"Authorization": f"Bearer {TOKEN}"}
LOG = logging.getLogger("t")


def test_keymap_table_spot_checks():
    assert keymap.CODES["KeyA"] == 30 and keymap.CODES["KeyZ"] == 44 and keymap.CODES["KeyM"] == 50
    assert keymap.CODES["Digit1"] == 2 and keymap.CODES["Digit0"] == 11
    assert keymap.CODES["F10"] == 68 and keymap.CODES["F11"] == 87 and keymap.CODES["F13"] == 183 and keymap.CODES["F24"] == 194
    assert keymap.CODES["ArrowDown"] == 108 and keymap.CODES["MetaLeft"] == 125 and keymap.CODES["NumpadEnter"] == 96


def test_parse_combo():
    assert keymap.parse_combo("ctrl+shift+a") == [29, 42, 30]
    assert keymap.parse_combo("Ctrl + Alt + Delete") == [29, 56, 111]
    assert keymap.parse_combo("KEY_ENTER") == [28]
    assert keymap.parse_combo("KEY_LEFTMETA+KEY_1") == [125, 2]
    assert keymap.parse_combo("ArrowUp") == [103]
    assert keymap.parse_combo("f5") == [63]
    assert keymap.parse_combo("A") == [30]
    assert keymap.parse_combo("ctrl+plus") == [29, 13]
    assert keymap.parse_combo("esc") == [1]
    for bad in ("", "ctrl+", "ctrl++a", "hyper", "KEY_NOPE"):
        with pytest.raises(ValueError):
            keymap.parse_combo(bad)


def test_text_keys_us_layout():
    assert keymap.text_keys("aA1!\n") == [(30, False), (30, True), (2, False), (2, True), (28, False)]
    assert keymap.text_keys("?") == [(53, True)]
    with pytest.raises(ValueError):
        keymap.text_keys("é")


def test_uinput_structs_and_ioctls():
    assert (uinput.EVENT.size, uinput.SETUP.size, uinput.ABS_SETUP.size) == (24, 92, 28)
    assert uinput.UI_DEV_CREATE == 0x5501 and uinput.UI_DEV_DESTROY == 0x5502
    assert uinput.UI_DEV_SETUP == 0x405C5503 and uinput.UI_ABS_SETUP == 0x401C5504
    assert (uinput.UI_SET_EVBIT, uinput.UI_SET_KEYBIT, uinput.UI_SET_RELBIT, uinput.UI_SET_ABSBIT) == (
        0x40045564, 0x40045565, 0x40045566, 0x40045567)
    assert uinput.UI_SET_PROPBIT == 0x4004556E and uinput.UI_GET_SYSNAME(64) == 0x8040552C
    packed = uinput.ABS_SETUP.pack(uinput.ABS_X, 0, -32768, 32767, 16, 128, 0)
    assert packed[:2] == b"\x00\x00" and packed[4:8] == (0).to_bytes(4, "little", signed=True)


def test_pad_values():
    v = pad_values({"a": True, "lb": False, "dpad_up": True}, {"lx": -1.0, "rt": 0.5}, None)
    assert v[(uinput.EV_KEY, uinput.BTN_A)] == 1 and v[(uinput.EV_KEY, uinput.BTN_TL)] == 0
    assert v[(uinput.EV_ABS, uinput.ABS_X)] == -32768 and v[(uinput.EV_ABS, uinput.ABS_RZ)] == 128
    assert v[(uinput.EV_ABS, uinput.ABS_HAT0Y)] == -1
    assert pad_values(hat=[1, 0])[(uinput.EV_ABS, uinput.ABS_HAT0X)] == 1
    for bad in ({"buttons": {"zz": True}}, {"axes": {"lx": "x"}}, {"hat": [1]}):
        with pytest.raises(ValueError):
            pad_values(**bad)


class FakeBackend:
    def __init__(self, name: str, fail: bool = False):
        self.name = name
        self.fail = fail
        self.events: list[tuple] = []
        self.frames = 0
        self.closed = False

    async def open(self):
        if self.fail:
            raise InputUnavailable("nope")

    def key(self, code, down):
        self.events.append(("key", code, down))

    def button(self, code, down):
        self.events.append(("button", code, down))

    def move_abs(self, x, y):
        self.events.append(("abs", round(x), round(y)))

    def move_rel(self, dx, dy):
        self.events.append(("rel", dx, dy))

    def scroll(self, dx, dy):
        self.events.append(("scroll", dx, dy))

    def frame(self):
        self.frames += 1

    def close(self):
        self.closed = True


class FakePad:
    def __init__(self):
        self.state = {}
        self.closed = False

    def apply(self, values):
        self.state.update(values)

    def neutral(self):
        self.state = {k: 0 for k in self.state}

    def close(self):
        self.closed = True


def make_service(tmp_path, *, ei_socket=True, uinput_ok=True, enabled=True, fail_ei=False, pad_idle=60.0):
    settings = Settings(token=TOKEN, input_enabled=enabled)
    if ei_socket:
        (tmp_path / "gamescope-0-ei").touch()
    backends: list[FakeBackend] = []
    pads: list[FakePad] = []
    sessions: list[str] = []

    def make_backend(name):
        b = FakeBackend(name, fail=fail_ei and name == "ei")
        backends.append(b)
        return b

    def make_pad():
        pads.append(FakePad())
        return pads[-1]

    async def on_session(remote):
        sessions.append(remote)

    async def focus():
        return (1280, 800)

    saved = []
    svc = InputService(lambda: settings, lambda: saved.append(1), LOG, on_session, runtime_dir=lambda: str(tmp_path),
                       make_backend=make_backend, make_gamepad=make_pad, uinput_available=lambda: uinput_ok,
                       focus_probe=focus, pad_idle=pad_idle)
    svc.t = type("T", (), {"backends": backends, "pads": pads, "sessions": sessions, "saved": saved, "settings": settings})
    return svc


def test_backend_selection(tmp_path):
    for d in "abc":
        (tmp_path / d).mkdir()
    assert make_service(tmp_path / "a").backend_name() == "ei"
    assert make_service(tmp_path / "b", ei_socket=False).backend_name() == "uinput"
    none = make_service(tmp_path / "c", ei_socket=False, uinput_ok=False)
    assert none.backend_name() is None
    st = none.status()
    assert st["available"] is False and "uinput" in st["reason"]


def test_ei_failure_falls_back_to_uinput(tmp_path):
    svc = make_service(tmp_path, fail_ei=True)

    async def run():
        s = svc.open_session("1.2.3.4")
        await svc.key(s, 42, True)
        assert [b.name for b in svc.t.backends] == ["ei", "uinput"]
        assert svc.backend_name() == "uinput"
        await svc.close_session(s)
    asyncio.run(run())


def test_held_keys_released_on_disconnect(tmp_path):
    svc = make_service(tmp_path)

    async def run():
        s = svc.open_session("1.2.3.4")
        await svc.handle(s, {"type": "key", "key": "ShiftLeft", "down": True})
        await svc.handle(s, {"type": "mouse_button", "button": "left", "down": True})
        await svc.handle(s, {"type": "mouse_move", "x": 0.5, "y": 1.0})
        await svc.handle(s, {"type": "wheel", "dx": 0, "dy": -1})
        b = svc.t.backends[0]
        assert b.events == [("key", 42, True), ("button", uinput.BTN_LEFT, True), ("abs", 640, 799), ("scroll", 0, -1)]
        assert s.keys == {42} and s.buttons == {uinput.BTN_LEFT}
        await svc.close_session(s)
        assert b.events[-2:] == [("key", 42, False), ("button", uinput.BTN_LEFT, False)]
        assert not s.keys and not s.buttons
        assert svc.t.sessions == ["1.2.3.4"]
        # Reconnecting from the same address soon after does not toast again.
        s2 = svc.open_session("1.2.3.4")
        await svc.handle(s2, {"type": "mouse_move", "dx": 1, "dy": 0})
        assert svc.t.sessions == ["1.2.3.4"]
    asyncio.run(run())


def test_disabled_refusal_and_disable_releases(tmp_path):
    svc = make_service(tmp_path, enabled=False)

    async def run():
        s = svc.open_session("x")
        with pytest.raises(InputDisabled):
            await svc.handle(s, {"type": "key", "code": 30, "down": True})
        assert svc.t.backends == []
        assert (await svc.set_enabled(True))["enabled"] is True and svc.t.saved == [1]
        await svc.handle(s, {"type": "key", "code": 30, "down": True})
        await svc.handle(s, {"type": "gamepad", "buttons": {"a": True}})
        assert svc.t.pads and svc.t.pads[0].state[(uinput.EV_KEY, uinput.BTN_A)] == 1
        await svc.set_enabled(False)
        b = svc.t.backends[0]
        assert b.events[-1] == ("key", 30, False) and b.closed
        assert svc.t.pads[0].closed and svc.t.pads[0].state[(uinput.EV_KEY, uinput.BTN_A)] == 0
        assert svc.t.settings.input_enabled is False
        with pytest.raises(ValueError):
            await svc.set_enabled("yes")
    asyncio.run(run())


def test_invalid_messages(tmp_path):
    svc = make_service(tmp_path)

    async def run():
        s = svc.open_session("x")
        for bad in ([1], {"type": "nope"}, {"type": "key", "key": "KeyA"}, {"type": "key", "key": "Bogus", "down": True},
                    {"type": "mouse_move"}, {"type": "mouse_move", "x": "a", "y": 0}, {"type": "text", "text": "ü"},
                    {"type": "mouse_button", "button": "thumb", "down": True}):
            with pytest.raises(ValueError):
                await svc.handle(s, bad)
    asyncio.run(run())


def test_rate_limit(tmp_path):
    svc = make_service(tmp_path)
    svc.rate = 5
    svc._tokens = 5.0

    async def run():
        s = svc.open_session("x")
        for _ in range(5):
            await svc.move_rel(s, 1, 0)
        with pytest.raises(ValueError, match="rate limit"):
            await svc.move_rel(s, 1, 0)
        # Releases are never dropped.
        s.keys.add(30)
        await svc.key(s, 30, False)
        assert svc.t.backends[0].events[-1] == ("key", 30, False)
    asyncio.run(run())


def test_gamepad_removed_after_idle(tmp_path):
    svc = make_service(tmp_path, pad_idle=0.1)

    async def run():
        s = svc.open_session("x")
        assert await svc.gamepad(s, pad_values({"a": False})) is True
        assert await svc.gamepad(s, pad_values({"a": False})) is False
        await asyncio.sleep(0.3)
        assert svc.t.pads[0].closed and svc.get_pad("auto") is None
    asyncio.run(run())


async def with_server(fn, svc):
    api = Api(auth=TokenAuth(TOKEN), mcp=McpServer(ToolRegistry(), LOG), capturer=None, logger=LOG,
              input_service=svc)
    runner = web.AppRunner(api.build_app())
    await runner.setup()
    await web.TCPSite(runner, "127.0.0.1", 0).start()
    base = f"http://127.0.0.1:{runner.addresses[0][1]}"
    try:
        async with ClientSession(timeout=ClientTimeout(total=10)) as s:
            await fn(s, base)
    finally:
        await runner.cleanup()


def test_input_settings_bearer_only(tmp_path):
    svc = make_service(tmp_path, enabled=False)

    async def run(s, base):
        async with s.get(f"{base}/input/settings") as r:
            assert r.status == 401
        async with s.get(f"{base}/input/settings", headers=H) as r:
            assert await r.json() == {"enabled": False, "backend": "ei", "available": True, "reason": None}
        async with s.put(f"{base}/input/settings", json={"enabled": True}, cookies={"decky_toolkit_token": TOKEN}) as r:
            assert r.status == 401, "the old viewer cookie authorises nothing"
        async with s.put(f"{base}/input/settings", json={"enabled": True}, headers=H) as r:
            assert r.status == 200 and (await r.json())["enabled"] is True
        async with s.get(f"{base}/input/settings", headers=H) as r:
            assert (await r.json())["enabled"] is True
        async with s.put(f"{base}/input/settings", json={"enabled": False}, headers=H) as r:
            assert (await r.json())["enabled"] is False
        for bad in ({"enabled": "yes"}, {}, {"enabled": True, "x": 1}, [True]):
            async with s.put(f"{base}/input/settings", json=bad, headers=H) as r:
                assert r.status == 400, bad
        async with s.put(f"{base}/input/settings", json={"enabled": True},
                         headers={**H, "Origin": "http://evil.example"}) as r:
            assert r.status == 403
        assert svc.t.settings.input_enabled is False
    asyncio.run(with_server(run, svc))


def test_input_ws_refused_when_disabled(tmp_path):
    svc = make_service(tmp_path, enabled=False)

    async def refused(s, base):
        with pytest.raises(WSServerHandshakeError) as e:
            await s.ws_connect(f"{base}/input")
        assert e.value.status == 401
        async with s.ws_connect(f"{base}/input", headers=H) as ws:
            msg = await ws.receive()
            assert msg.type == WSMsgType.CLOSE and msg.data == 4003
    asyncio.run(with_server(refused, svc))


async def recv(ws):
    # State broadcasts (backend opened, focus size) can interleave with replies.
    while (msg := await ws.receive_json())["type"] == "state":
        pass
    return msg


def test_input_ws_state_events_and_release(tmp_path):
    svc = make_service(tmp_path)

    async def run(s, base):
        async with s.ws_connect(f"{base}/input", headers=H) as ws:
            assert await ws.receive_json() == {"type": "state", "enabled": True, "backend": "ei", "focus_size": [1280, 800]}
            await ws.send_json({"type": "key", "key": "ShiftLeft", "down": True})
            await ws.send_json({"type": "bogus"})
            err = await recv(ws)
            assert err["type"] == "error" and "bogus" in err["message"]
            await ws.send_str("{not json")
            assert (await recv(ws))["type"] == "error"
            await ws.send_json({"type": "mouse_move", "x": 0.5, "y": 0.5, "id": 7})
            assert await recv(ws) == {"type": "ack", "id": 7}
        for _ in range(50):
            if svc.t.backends and svc.t.backends[0].events[-1] == ("key", 42, False):
                break
            await asyncio.sleep(0.02)
        assert svc.t.backends[0].events[0] == ("key", 42, True)
        assert svc.t.backends[0].events[-1] == ("key", 42, False)
        assert svc.t.sessions == ["127.0.0.1"]

        async with s.ws_connect(f"{base}/input", headers=H) as ws:
            await ws.receive_json()
            await svc.set_enabled(False)
            msg = await ws.receive()
            while msg.type == WSMsgType.TEXT:
                msg = await ws.receive()
            assert msg.type == WSMsgType.CLOSE and msg.data == 4003
    asyncio.run(with_server(run, svc))


def test_input_tools_refuse_when_disabled_and_work_when_enabled(tmp_path):
    svc = make_service(tmp_path, enabled=False)
    reg = build_registry(None, svc)

    async def run():
        for name, args in (("input_key", {"keys": "ctrl+a"}), ("input_text", {"text": "hi"}),
                           ("input_mouse", {"action": "click", "x": 0.5, "y": 0.5}),
                           ("input_gamepad", {"buttons": {"a": True}})):
            res = await reg.call(name, args)
            assert res["isError"] and "disabled" in res["content"][0]["text"], name
        res = await reg.call("set_input_enabled", {"enabled": True})
        assert not res["isError"] and json.loads(res["content"][0]["text"])["enabled"] is True
        res = await reg.call("input_key", {"keys": "ctrl+a", "hold_ms": 0})
        assert not res["isError"], res
        b = svc.t.backends[0]
        assert b.events == [("key", 29, True), ("key", 30, True), ("key", 30, False), ("key", 29, False)]
        res = await reg.call("input_mouse", {"action": "click", "x": 0.5, "y": 0.5})
        assert not res["isError"] and b.events[-3:] == [("abs", 640, 400), ("button", uinput.BTN_LEFT, True),
                                                         ("button", uinput.BTN_LEFT, False)]
        res = await reg.call("input_mouse", {"action": "scroll", "amount": -2})
        assert b.events[-1] == ("scroll", 0, -2)
        res = await reg.call("input_key", {"keys": "hyper+a"})
        assert res["isError"] and "unknown key" in res["content"][0]["text"]
    asyncio.run(run())
