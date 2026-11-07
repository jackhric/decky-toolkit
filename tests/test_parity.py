"""Routes and their MCP tool twins go through the same function with the same rules: each pair is called through the
real aiohttp app and the real registry, built from one Services, and must reach the same domain function and refuse the
same input with the same message. Run with: ./scripts/test.sh"""
import asyncio
import inspect
import json
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import quote

import pytest

from certauth import H
from decky_toolkit import errors
from decky_toolkit.games import files as games
from decky_toolkit.loader import live, logs
from decky_toolkit.media.capture import ScreenCapturer
from decky_toolkit.server.events import EventHub
from decky_toolkit.settings import Settings
from decky_toolkit.steam import ui
from decky_toolkit.steam.apps import Apps
from decky_toolkit.tools import build_registry
from harness import LOG, make_services, with_server

from test_apps import FakeSteam
from test_controllers import FakeSteamUi


@dataclass
class Pair:
    route: tuple[str, str, Any]  # method, path under /api/v1, JSON body or raw bytes
    tool: tuple[str, dict[str, Any]]
    status: int  # what the route answers; 200 means both succeed
    via: tuple[Any, str] | None = None  # the domain function both must call
    id: str = field(default="")


@pytest.fixture
def device(tmp_path, monkeypatch):
    home = tmp_path / "home"
    steam = home / ".local/share/Steam"
    (steam / "config").mkdir(parents=True)
    (steam / "config/loginusers.vdf").write_text("secret")
    (steam / "steamapps").mkdir()
    (steam / "steamapps/libraryfolders.vdf").write_text(f'"libraryfolders" {{ "0" {{ "path" "{steam}" }} }}')
    (home / ".ssh").mkdir()
    (home / ".ssh/id_ed25519").write_text("key")
    (home / "notes.txt").write_text("hello")
    runtime = tmp_path / "runtime"
    (runtime / "recordings").mkdir(parents=True)
    (runtime / "recordings/a.mkv").write_bytes(b"mkv")
    plugins = tmp_path / "decky/plugins/demo"
    plugins.mkdir(parents=True)
    (plugins / "plugin.json").write_text(json.dumps({"name": "Demo Plugin"}))
    (tmp_path / "decky/logs/demo").mkdir(parents=True)
    (tmp_path / "decky/logs/demo/2026-11-06 02.00.00.log").write_text("[2026-11-06 02:00:00,000][INFO]: up\n")
    monkeypatch.setenv("DECKY_USER_HOME", str(home))
    monkeypatch.setenv("DECKY_HOME", str(tmp_path / "decky"))
    monkeypatch.setenv("DECKY_PLUGIN_RUNTIME_DIR", str(runtime))
    return {"home": home, "steam": steam, "runtime": runtime}


def q(path: str) -> str:
    return quote(path, safe="/~")


def pairs(d) -> list[Pair]:
    login, key = f"{d['steam']}/config/loginusers.vdf", f"{d['home']}/.ssh/id_ed25519"
    libs, rec = f"{d['steam']}/steamapps/libraryfolders.vdf", f"{d['runtime']}/recordings/a.mkv"
    return [
        Pair(("GET", f"/fs/read?path={q(login)}", None), ("fs_read", {"path": login}), 403, (games, "fs_read"), "read-login"),
        Pair(("GET", f"/fs/read?path={q(key)}", None), ("fs_read", {"path": key}), 403, (games, "fs_read"), "read-ssh"),
        Pair(("GET", "/fs/read?path=relative", None), ("fs_read", {"path": "relative"}), 400, (games, "fs_read"), "read-relative"),
        Pair(("GET", "/fs/read?path=~/nope", None), ("fs_read", {"path": "~/nope"}), 404, (games, "fs_read"), "read-missing"),
        Pair(("GET", "/fs/read?path=~/.ssh", None), ("fs_read", {"path": "~/.ssh"}), 409, (games, "fs_read"), "read-dir"),
        Pair(("GET", f"/fs?path={q(login)}", None), ("fs_list", {"path": login}), 403, (games, "fs_list"), "list-login"),
        Pair(("GET", "/fs?path=~/nope", None), ("fs_list", {"path": "~/nope"}), 404, (games, "fs_list"), "list-missing"),
        Pair(("GET", "/fs?path=~&depth=9", None), ("fs_list", {"path": "~", "depth": 9}), 400, (games, "fs_list"), "list-depth"),
        Pair(("GET", "/fs?path=~", None), ("fs_list", {"path": "~"}), 200, (games, "fs_list"), "list-home"),
        Pair(("PUT", f"/fs/write?path={q(login)}", b"x"), ("fs_write", {"path": login, "content": "x"}), 403,
             (games, "fs_write"), "write-login"),
        Pair(("PUT", f"/fs/write?path={q(libs)}", b"x"), ("fs_write", {"path": libs, "content": "x"}), 403,
             (games, "fs_write"), "write-libraryfolders"),
        Pair(("PUT", f"/fs/write?path={q(key)}", b"x"), ("fs_write", {"path": key, "content": "x"}), 403,
             (games, "fs_write"), "write-ssh"),
        Pair(("PUT", "/fs/write?path=relative", b"x"), ("fs_write", {"path": "relative", "content": "x"}), 400,
             (games, "fs_write"), "write-relative"),
        Pair(("PUT", f"/fs/write?path={q(rec)}&mode=9z", b"x"), ("fs_write", {"path": rec, "content": "x", "mode": "9z"}),
             400, None, "write-mode"),
        Pair(("DELETE", f"/fs?path={q(login)}&confirm=1", None), ("fs_delete", {"path": login, "confirm": True}), 403,
             (games, "fs_delete"), "delete-login"),
        Pair(("DELETE", "/fs?path=~/notes.txt&confirm=1", None), ("fs_delete", {"path": "~/notes.txt", "confirm": True}),
             403, (games, "fs_delete"), "delete-outside-roots"),
        Pair(("DELETE", f"/fs?path={q(rec)}.gone&confirm=1", None), ("fs_delete", {"path": rec + ".gone", "confirm": True}),
             404, (games, "fs_delete"), "delete-missing"),
        Pair(("PUT", "/stream/settings", {"fps": "fast"}), ("stream_settings", {"fps": "fast"}), 400,
             (ScreenCapturer, "update_settings"), "stream-bad-fps"),
        Pair(("PUT", "/stream/settings", {"audio": 1}), ("stream_settings", {"audio": 1}), 400,
             (ScreenCapturer, "update_settings"), "stream-bad-audio"),
        Pair(("PUT", "/input/settings", {"enabled": "yes"}), ("input_settings", {"enabled": "yes"}), 400, None,
             "input-bad-enabled"),
        Pair(("POST", "/plugins/reload", {"plugin": "Demo", "mode": "sideways"}),
             ("plugin_reload", {"plugin": "Demo", "mode": "sideways"}), 400, (live, "reload"), "reload-mode"),
        Pair(("POST", "/plugins/reload", {"plugin": "nope"}), ("plugin_reload", {"plugin": "nope"}), 404, None,
             "reload-missing"),
        Pair(("POST", "/ui/navigate", {"action": "fly"}), ("ui_navigate", {"action": "fly"}), 400, None, "navigate-action"),
        Pair(("POST", "/ui/navigate", {"path": "/nowhere"}), ("ui_navigate", {"path": "/nowhere"}), 400, None,
             "navigate-route"),
        Pair(("POST", "/apps/70300/terminate", {}), ("app_terminate", {"appid": 70300, "confirm": False}), 400,
             (Apps, "terminate"), "terminate-confirm"),
    ]


def spy(monkeypatch, owner, name) -> list:
    calls: list = []
    real = getattr(owner, name)
    if inspect.iscoroutinefunction(real):
        async def wrapped(*a, **k):
            calls.append(a)
            return await real(*a, **k)
    else:
        def wrapped(*a, **k):
            calls.append(a)
            return real(*a, **k)
    monkeypatch.setattr(owner, name, wrapped)
    return calls


def services():
    settings = Settings()
    return make_services(capturer=ScreenCapturer(lambda: settings, LOG, EventHub()), apps=Apps(FakeSteam()),
                         ui=ui.UiNavigator(FakeSteamUi(), settle=0))


def tool_message(res: dict) -> str:
    """The message of an expected tool error: `<Exception>: <message>`, no traceback."""
    text = res["content"][0]["text"]
    assert "Traceback" not in text, text
    return text.split(": ", 1)[1]


def test_routes_and_tools_share_functions_and_rules(device, monkeypatch):
    cases = pairs(device)
    spies = {via: spy(monkeypatch, *via) for via in {c.via for c in cases if c.via}}
    s = services()
    reg = build_registry(s)

    async def run(session, base):
        for case in cases:
            for calls in spies.values():
                calls.clear()
            method, path, body = case.route
            kwargs = {"json": body} if isinstance(body, dict) else {"data": body}
            async with session.request(method, f"{base}/api/v1{path}", headers=H, **kwargs) as r:
                route_body = await r.json() if r.content_type == "application/json" else await r.read()
                assert r.status == case.status, (case.id, r.status, route_body)
            res = await reg.call(*case.tool)
            if case.status == 200:
                assert not res["isError"], (case.id, res)
                assert json.loads(res["content"][0]["text"]) == route_body, case.id
            else:
                assert res["isError"], (case.id, res)
                message = tool_message(res)
                assert message == route_body["error"], (case.id, message, route_body)
            if case.via:
                assert len(spies[case.via]) == 2, (case.id, "both sides must call", case.via[1])
    asyncio.run(with_server(run, services=s))


def test_shared_state_and_same_answers(device):
    s = services()
    reg = build_registry(s)

    async def tool(name, args=None):
        res = await reg.call(name, args or {})
        assert not res["isError"], res
        return json.loads(res["content"][0]["text"])

    async def run(session, base):
        async def get(path):
            async with session.get(f"{base}/api/v1{path}", headers=H) as r:
                assert r.status == 200, path
                return await r.json()

        async with session.put(f"{base}/api/v1/stream/settings", json={"fps": 20}, headers=H) as r:
            assert (await r.json())["fps"] == 20
        assert (await tool("stream_settings"))["fps"] == 20, "the route and the tool hold one capturer"
        await tool("stream_settings", {"quality": 55})
        assert (await get("/stream/settings"))["quality"] == 55
        assert await get("/input/settings") == await tool("input_settings")
        assert await get("/apps?query=v") == await tool("app_list", {"query": "v"})
        assert await get("/apps/70300/dirs") == await tool("app_dirs", {"appid": 70300})
        listed = await tool("plugin_list")
        assert [{k: p[k] for k in ("dir", "name")} for p in listed] == [{k: p[k] for k in ("dir", "name")}
                                                                         for p in await get("/plugins")]
        assert (await get("/logs/tail?plugin=Demo%20Plugin&tail=5"))["lines"] == logs.read_plugin("demo", 5)["lines"]
        async with session.post(f"{base}/api/v1/ui/navigate", json={"path": "/library/home"}, headers=H) as r:
            route_nav = await r.json()
        assert route_nav == await tool("ui_navigate", {"path": "/library/home"})
    asyncio.run(with_server(run, services=s))


def test_every_route_error_status_comes_from_the_table():
    # A route answering a status the table does not hold would be a second error mapping.
    assert {p.status for p in pairs({"steam": "/s", "home": "/h", "runtime": "/r"}) if p.status != 200} <= \
        {status for _, status, _ in errors.ERRORS}
