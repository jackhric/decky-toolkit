"""Controllers (evdev parsing, Steam Input merge, virtual pad registry, routes) and UI navigation. Run with: ./scripts/test.sh"""
import asyncio
import json
import logging
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "py_modules"))

from aiohttp import ClientSession, ClientTimeout, web  # noqa: E402

from decky_toolkit.steam import cdp, ui  # noqa: E402
from certauth import H, stub_auth  # noqa: E402
import sse  # noqa: E402
from decky_toolkit.server.events import EventHub  # noqa: E402
from decky_toolkit.input.controllers import ControllerService, evdev_gamepads, merge, parse_bitmap  # noqa: E402
from decky_toolkit.server.http import Api  # noqa: E402
from decky_toolkit.input import uinput  # noqa: E402
from decky_toolkit.input.service import InputDisabled, InputService, InputUnavailable, VirtualPad, pad_values  # noqa: E402
from decky_toolkit.server.protocol import McpServer  # noqa: E402
from decky_toolkit.settings import Settings  # noqa: E402
from decky_toolkit.tools import ToolRegistry, build_registry  # noqa: E402

LOG = logging.getLogger("t")
FIXTURE = (Path(__file__).parent / "fixtures" / "proc_bus_input_devices.txt").read_text()

# Steam Input's list as window.ControllerStore reported it on the device while the fixture was captured.
STEAM = {"active": 2, "controllers": [
    {"index": 0, "xinput": 0, "type_id": 32, "type": "controller_xboxone", "type_name": "Xbox One controller",
     "name": "Xbox One controller", "vendor": 1118, "product": 2834, "serial": "45e-b12-5b2bb70"},
    {"index": 1, "xinput": 1, "type_id": 31, "type": "controller_xbox360", "type_name": "Xbox 360 controller",
     "name": "Controller 1", "vendor": 1118, "product": 654, "serial": "45e-28e-5b2bb70"},
    {"index": 2, "xinput": 2, "type_id": 31, "type": "controller_xbox360", "type_name": "Xbox 360 controller",
     "name": "Controller 2", "vendor": 1118, "product": 654, "serial": "45e-28e-5b2bb70g"},
]}


def test_parse_bitmap():
    assert parse_bitmap("7cdb000000000000 0 8000000000 0 0") >= {0x130, 0x131, 0x133, 0x13e, 167}
    assert 0x130 not in parse_bitmap("8000 10000000000000 0")
    assert parse_bitmap("") == set()


def test_evdev_gamepads_from_fixture():
    pads = evdev_gamepads(FIXTURE)
    assert [(d.name, d.vendor, d.product, d.event, d.virtual) for d in pads] == [
        ("Microsoft Xbox Controller", "045e", "0b12", "/dev/input/event7", False),
        ("Microsoft X-Box 360 pad", "045e", "028e", "/dev/input/event9", True),
        ("Microsoft X-Box 360 pad", "045e", "028e", "/dev/input/event10", True),
    ], "Steam's own 28de:11ff output pads are not inputs and are left out"
    assert [d.sysname for d in pads] == ["input37", "input40", "input41"]


class Dev:
    def __init__(self, sysname=None):
        self.sysname = sysname
        self.state = {}
        self.closed = False

    def apply(self, values):
        self.state.update(values)

    def neutral(self):
        self.state = {k: 0 for k in self.state}

    def close(self):
        self.closed = True


def test_merge_steam_primary():
    p1 = VirtualPad("pad1", "Left", Dev("input40"), created_at=1.0)
    p2 = VirtualPad("pad2", "Right", Dev("input41"), created_at=2.0, steam_serial="45e-28e-5b2bb70g")
    out = merge(evdev_gamepads(FIXTURE), STEAM, [p1, p2])
    assert [c["id"] for c in out] == ["steam:45e-b12-5b2bb70", "pad1", "pad2"]
    xb, v1, v2 = out
    assert xb["kind"] == "physical" and xb["device"] == "/dev/input/event7" and xb["vendor"] == "045e"
    assert xb["steam"] == {"type": "controller_xboxone", "slot": 0, "name": "Xbox One controller", "index": 0,
                           "type_name": "Xbox One controller", "active": False}
    assert xb["name"] == "Xbox One controller" and xb["seen_by_steam"] is True
    assert v1["kind"] == "virtual" and v1["virtual_id"] == "pad1" and v1["device"] == "/dev/input/event9"
    assert v1["steam"]["name"] == "Controller 1" and v1["name"] == "Left"
    assert v2["steam"]["slot"] == 2 and v2["steam"]["active"] is True and v2["device"] == "/dev/input/event10"


def test_merge_without_steam_marks_unseen():
    out = merge(evdev_gamepads(FIXTURE), None, [VirtualPad("pad1", "P", Dev("input40"))])
    assert [(c["id"], c["kind"], c["seen_by_steam"], c["steam"]) for c in out] == [
        ("evdev:input37", "physical", False, None), ("pad1", "virtual", False, None),
        ("evdev:input41", "virtual", False, None)]


def test_merge_steam_only_device():
    steam = {"active": 0, "controllers": [{"index": 0, "xinput": -1, "type": "controller_neptune", "name": "Steam Deck",
                                           "type_name": "Steam Deck", "vendor": 10462, "product": 4613, "serial": "X"}]}
    (c,) = merge([], steam, [])
    assert c["device"] is None and c["vendor"] == "28de" and c["product"] == "1205" and c["steam"]["slot"] is None


def make_service(enabled=False, pad_idle=60.0, uinput_ok=True):
    settings = Settings(input_enabled=enabled)
    made: list[Dev] = []

    def make_pad():
        made.append(Dev(f"input{90 + len(made)}"))
        return made[-1]

    svc = InputService(lambda: settings, None, LOG, runtime_dir=lambda: "/nonexistent", make_gamepad=make_pad,
                       uinput_available=lambda: uinput_ok, pad_idle=pad_idle)
    svc.made = made
    return svc


def test_registry_limits_and_lifetimes():
    svc = make_service(enabled=False, pad_idle=0.1)
    changes = []
    svc.add_pad_listener(lambda: changes.append(1))

    async def run():
        pads = [svc.add_pad("A"), svc.add_pad(), svc.add_pad(), svc.add_pad()]
        assert [p.id for p in pads] == ["pad1", "pad2", "pad3", "pad4"] and pads[1].name == "Virtual pad 2"
        with pytest.raises(ValueError, match="at most 4"):
            svc.add_pad()
        with pytest.raises(ValueError):
            svc.add_pad(5)
        s = svc.open_session("x")
        with pytest.raises(InputDisabled):
            await svc.gamepad(s, pad_values({"a": True}), "pad1")
        await svc.set_enabled(True)
        await svc.gamepad(s, pad_values({"a": True}), "pad1")
        assert pads[0].dev.state[(uinput.EV_KEY, uinput.BTN_A)] == 1 and pads[0].last_event_at is not None
        with pytest.raises(ValueError, match="unknown virtual gamepad"):
            await svc.gamepad(s, pad_values({"a": True}), "pad9")
        # The implicit pad is extra (not counted against the limit) and is the only one idle-removed.
        assert await svc.gamepad(s, pad_values({"b": True})) is True
        assert svc.get_pad("auto").auto and len(svc.pads()) == 5
        await svc.close_session(s)
        assert pads[0].dev.state[(uinput.EV_KEY, uinput.BTN_A)] == 0, "session end neutralises the pads it used"
        await asyncio.sleep(0.3)
        assert svc.get_pad("auto") is None and len(svc.pads()) == 4
        assert svc.remove_pad("pad2") is True and svc.remove_pad("pad2") is False and pads[1].dev.closed
        svc.add_pad()
        assert svc.pads()[-1].id == "pad5"
        assert await svc.gamepad(svc.open_session("y"), pad_values({"x": True})) is True
        await svc.set_enabled(False)
        assert svc.get_pad("auto") is None and len(svc.pads()) == 4, "disabling input keeps explicit pads"
        await svc.shutdown()
        assert svc.pads() == [] and all(d.closed for d in svc.made)
    asyncio.run(run())
    assert len(changes) >= 10


def test_registry_without_uinput():
    svc = make_service(uinput_ok=False)
    with pytest.raises(InputUnavailable):
        svc.add_pad()


class FakeSteam:
    """Steam Input that lists every pad the fake uinput created (or none when blind)."""

    def __init__(self, svc, blind=False, down=False):
        self.svc, self.blind, self.down = svc, blind, down

    async def __call__(self):
        if self.down:
            return None
        listed = [] if self.blind else [d for d in self.svc.made if not d.closed]
        return {"active": 0, "controllers": [
            {"index": i, "xinput": i, "type": "controller_xbox360", "type_name": "Xbox 360 controller",
             "name": f"Controller {i}", "vendor": 1118, "product": 654, "serial": f"s-{d.sysname}"}
            for i, d in enumerate(listed)]}


def devices_text(svc):
    blocks = []
    for d in svc.made:
        if not d.closed:
            blocks.append(f'I: Bus=0003 Vendor=045e Product=028e Version=0114\nN: Name="Microsoft X-Box 360 pad"\n'
                          f'S: Sysfs=/devices/virtual/input/{d.sysname}\nH: Handlers=event{d.sysname[5:]} js0 \n'
                          f'B: KEY=7cdb000000000000 0 0 0 0\n')
    return "\n".join(blocks)


def make_controllers(svc, events=None, **steam):
    return ControllerService(svc, LOG, read_devices=lambda: devices_text(svc), steam_query=FakeSteam(svc, **steam),
                             poll=0.05, steam_poll=0.05, confirm_seconds=0.6, events=events)


def test_add_virtual_confirmed_by_steam():
    svc = make_service()
    cs = make_controllers(svc)

    async def run():
        assert await cs.add_virtual("Mine") == {"id": "pad1", "name": "Mine", "type": "x360"}
        assert svc.get_pad("pad1").steam_serial == "s-input90"
        snap = await cs.snapshot()
        assert snap["input_enabled"] is False and snap["steam_available"] is True
        (c,) = snap["controllers"]
        assert c["id"] == "pad1" and c["device"] == "/dev/input/event90" and c["steam"]["type"] == "controller_xbox360"
        assert snap["virtual"][0]["auto"] is False
        # Steam Input lingers on a removed pad for a moment; the list hides that ghost.
        steam = cs._steam_query
        lingering = {"active": 0, "controllers": (await steam())["controllers"]}
        cs._steam_query = lambda: asyncio.sleep(0, lingering)
        assert cs.remove_virtual("pad1") is True
        assert (await cs.snapshot())["controllers"] == []
        cs._steam_query = steam
        assert (await cs.add_virtual())["id"] == "pad2"
    asyncio.run(run())


def test_add_virtual_refused_when_steam_does_not_list_it():
    svc = make_service()

    async def run():
        with pytest.raises(InputUnavailable, match="did not list"):
            await make_controllers(svc, blind=True).add_virtual()
        assert svc.pads() == [] and svc.made[0].closed
        with pytest.raises(InputUnavailable, match="not reachable"):
            await make_controllers(svc, down=True).add_virtual()
        assert len(svc.made) == 1
    asyncio.run(run())


async def with_server(fn, **kwargs):
    api = Api(auth=stub_auth(), mcp=McpServer(ToolRegistry(), LOG), capturer=None, logger=LOG,
              log_keepalive=0.2, **kwargs)
    runner = web.AppRunner(api.build_app())
    await runner.setup()
    await web.TCPSite(runner, "127.0.0.1", 0).start()
    base = f"http://127.0.0.1:{runner.addresses[0][1]}"
    try:
        async with ClientSession(timeout=ClientTimeout(total=10)) as s:
            await fn(s, base)
    finally:
        await runner.cleanup()


def test_controller_routes_and_events():
    svc = make_service()
    events = EventHub()
    cs = make_controllers(svc, events=events)

    async def listed():
        return cs.event(await cs.snapshot())
    events.sources["controllers"] = listed

    async def run(s, base):
        async with s.get(f"{base}/api/v1/controllers") as r:
            assert r.status == 401
        async with s.get(f"{base}/api/v1/controllers", headers=H) as r:
            body = await r.json()
            assert body["controllers"] == [] and body["virtual"] == [] and body["input_enabled"] is False
        async with s.get(f"{base}/api/v1/events", headers=H) as ev:
            hello = await sse.wait_for(ev, "hello")
            assert hello["state"]["controllers"] == {"controllers": [], "virtual": []}
            async with s.post(f"{base}/api/v1/controllers/virtual", json={"name": "P1"}, headers=H) as r:
                assert r.status == 201 and await r.json() == {"id": "pad1", "name": "P1", "type": "x360"}
            ev1 = await asyncio.wait_for(sse.wait_for(ev, "controllers", lambda d: d["controllers"] and d["controllers"][0]["seen_by_steam"]), 3)
            assert ev1["virtual"][0]["id"] == "pad1" and ev1["controllers"][0]["virtual_id"] == "pad1"
            async with s.delete(f"{base}/api/v1/controllers/virtual/pad1", headers=H) as r:
                assert r.status == 200 and await r.json() == {"removed": "pad1"}
            ev2 = await asyncio.wait_for(sse.wait_for(ev, "controllers", lambda d: not d["virtual"]), 3)
            assert ev2["controllers"] == []
        async with s.delete(f"{base}/api/v1/controllers/virtual/pad1", headers=H) as r:
            assert r.status == 404
        for bad in ({"name": 3}, {"x": 1}, [1]):
            async with s.post(f"{base}/api/v1/controllers/virtual", json=bad, headers=H) as r:
                assert r.status == 400, bad
        async with s.post(f"{base}/api/v1/controllers/virtual", headers=H) as r:
            assert r.status == 201 and (await r.json())["name"] == "Virtual pad 2"
        for _ in range(50):
            if cs._task is None or cs._task.done():
                break
            await asyncio.sleep(0.05)
        assert cs._task.done(), "the watcher stops once the last event stream closed"
    asyncio.run(with_server(run, input_service=svc, controllers=cs, events=events))


def test_controller_tools():
    svc = make_service()
    reg = build_registry(None, svc, make_controllers(svc))

    async def run():
        res = await reg.call("controller_add", {"name": "T"})
        assert not res["isError"] and json.loads(res["content"][0]["text"])["id"] == "pad1"
        listed = json.loads((await reg.call("controller_list", {}))["content"][0]["text"])
        assert listed["virtual"][0]["name"] == "T"
        res = await reg.call("input_gamepad", {"buttons": {"a": True}, "pad": "pad1"})
        assert res["isError"] and "disabled" in res["content"][0]["text"]
        await svc.set_enabled(True)
        res = await reg.call("input_gamepad", {"buttons": {"a": True}, "pad": "nope"})
        assert res["isError"] and "unknown virtual gamepad" in res["content"][0]["text"]
        res = await reg.call("input_gamepad", {"buttons": {"a": True}, "pad": "pad1", "hold_ms": 0})
        assert not res["isError"] and "pad1" in res["content"][0]["text"] and svc.get_pad("auto") is None
        assert svc.get_pad("pad1").last_event_at is not None
        res = await reg.call("controller_remove", {"id": "pad1"})
        assert not res["isError"] and svc.pads() == []
        res = await reg.call("controller_remove", {"id": "pad1"})
        assert res["isError"]
    asyncio.run(run())


# ---- UI navigation ----

def test_parse_request_validation():
    assert ui.parse_request(path="/library/home/") == {"path": "/library/home"}
    assert ui.parse_request(action="quick_access", tab="Decky") == {"action": "quick_access", "tab": "decky"}
    assert ui.parse_request(action="app", appid="730") == {"action": "app", "appid": 730}
    assert ui.parse_request(action="plugin", plugin=" Decky Toolkit ") == {"action": "plugin", "plugin": "Decky Toolkit"}
    for bad in ({}, {"path": "/a", "action": "back"}, {"path": "library"}, {"path": 3}, {"action": "fly"},
                {"action": "quick_access", "tab": "nope"}, {"action": "back", "tab": "decky"}, {"action": "plugin"},
                {"action": "app", "appid": -1}, {"action": "app", "appid": True}, {"path": "/x", "appid": 1},
                {"action": "back", "plugin": "x"}, {"path": "/a\nb"}):
        with pytest.raises(ValueError):
            ui.parse_request(**bad)


STEAM_ROUTES = ["/library/home", "/library/app/:appid", "/library", "/settings", "/notes/app/:appid/:noteid?", "/media"]


def test_known_path():
    k = lambda p: ui.known_path(p, STEAM_ROUTES, ["/tender", "/decky/settings"])  # noqa: E731
    assert k("/library/home") and k("/settings/display") and k("/library/app/730") and k("/tender")
    assert k("/settings/controller/controller_xboxone/0") and k("/notes/app/1") and k("/notes/app/1/2") and k("/media")
    assert not k("/settings/bogus") and not k("/bogus") and not k("/library/app") and not k("/")
    assert ui.owner_of("/decky/store", ["Tender"]) == "Decky Loader"
    assert ui.owner_of("/tender/main", ["Tender", "Decky Toolkit"]) == "Tender"
    assert ui.owner_of("/decky-toolkit/panel", ["Decky Toolkit"]) == "Decky Toolkit"
    assert ui.owner_of("/other", ["Tender"]) == "unknown"


class FakeSteamUi:
    def __init__(self):
        self.scripts: list[str] = []

    async def __call__(self, js):
        self.scripts.append(js)
        if "routerHook" in js and "_routes" in js:
            return {"steam": STEAM_ROUTES, "decky": ["/decky/settings", "/tender"], "patches": ["/library/app/:appid"],
                    "plugins": ["Tender", "Decky Toolkit"], "tabs": ["Notifications", "Decky"],
                    "state": {"current": "/library/home", "side_menu": 0, "quick_access_tab": 999, "active_plugin": None}}
        if "unknown Decky plugin" in js and "nosuch" in js:
            raise cdp.CdpError("JS exception: Error: DMCP: unknown Decky plugin \"nosuch\"; loaded: Tender\n    at x")
        if js.startswith("(async"):
            return 1
        return {"current": "/settings/display", "side_menu": 2, "quick_access_tab": 999, "active_plugin": "Tender"}


def test_navigator():
    fake = FakeSteamUi()
    nav = ui.UiNavigator(fake, settle=0)

    async def run():
        r = await nav.routes()
        assert r["current"] == "/library/home" and r["side_menu"] == "none" and r["quick_access_tabs"] == ["notifications", "decky"]
        assert {"plugin": "Tender", "path": "/tender", "title": "Tender"} in r["plugins"]
        assert {"plugin": "Decky Loader", "path": "/decky/settings", "title": "Decky settings"} in r["plugins"]
        assert any(o["path"] == "/library/app/{appid}" and o["template"] for o in r["official"])
        res = await nav.navigate(path="/settings/display")
        assert res == {"ok": True, "current": "/settings/display", "side_menu": "quick_access",
                       "quick_access_tab": "decky", "active_plugin": "Tender", "running_app": None, "dialog": None, "keyboard": False}
        assert 'N.Navigate("/settings/display"); N.CloseSideMenus()' in fake.scripts[-2]
        with pytest.raises(ValueError, match="unknown route '/nowhere'.*/library/home"):
            await nav.navigate(path="/nowhere")
        await nav.navigate(action="quick_access", tab="decky")
        assert "OpenQuickAccessMenu" in fake.scripts[-2] and '"decky"' in fake.scripts[-2]
        await nav.navigate(action="plugin", plugin="tender")
        assert "setActivePlugin" in fake.scripts[-2]
        with pytest.raises(ValueError, match="unknown Decky plugin"):
            await nav.navigate(action="plugin", plugin="nosuch")
        await nav.navigate(action="back")
        assert "N.NavigateBack()" in fake.scripts[-2]
        await nav.navigate(action="app", appid=730)
        assert "/library/app/730" in fake.scripts[-2]
        await nav.navigate(path="/settings/controller")
        assert "GetControllersSorted" in fake.scripts[-2]
    asyncio.run(run())


def test_ui_routes_http():
    fake = FakeSteamUi()

    async def run(s, base):
        async with s.get(f"{base}/api/v1/ui/routes", headers=H) as r:
            assert r.status == 200 and (await r.json())["current"] == "/library/home"
        async with s.post(f"{base}/api/v1/ui/navigate", json={"path": "/library/home"}, headers=H) as r:
            assert r.status == 200 and (await r.json())["ok"] is True
        async with s.post(f"{base}/api/v1/ui/navigate", json={"action": "fly"}, headers=H) as r:
            assert r.status == 400 and "back" in (await r.json())["error"]
        async with s.post(f"{base}/api/v1/ui/navigate", json={"path": "/nowhere"}, headers=H) as r:
            assert r.status == 400 and "/library/home" in (await r.json())["error"]
        async with s.post(f"{base}/api/v1/ui/navigate", json={"path": "/a", "extra": 1}, headers=H) as r:
            assert r.status == 400
        async with s.post(f"{base}/api/v1/ui/navigate", json={"action": "back"}) as r:
            assert r.status == 401
    asyncio.run(with_server(run, ui=ui.UiNavigator(fake, settle=0)))


def test_ui_502_when_steam_unreachable():
    async def down(js):
        raise cdp.CdpError("Steam CEF debugger not reachable")

    async def run(s, base):
        async with s.get(f"{base}/api/v1/ui/routes", headers=H) as r:
            assert r.status == 502
        async with s.post(f"{base}/api/v1/ui/navigate", json={"action": "back"}, headers=H) as r:
            assert r.status == 502
    asyncio.run(with_server(run, ui=ui.UiNavigator(down, settle=0)))
