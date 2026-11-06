"""Steam library tools against a fake Steam JS context, plus the /apps routes. Run with: ./scripts/test.sh"""
import asyncio
import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "py_modules"))

from decky_toolkit.steam import apps as apps_mod, cdp  # noqa: E402
from decky_toolkit.server import http as http_mod  # noqa: E402
from decky_toolkit.steam.apps import Apps  # noqa: E402

from test_routes import H, with_server  # noqa: E402

ROW = {"appid": 70300, "name": "VVVVVV", "app_type": 1, "gameid": "70300", "installed": True, "installed_elsewhere": [],
       "size_on_disk": 75883262, "last_played": 1793779877, "playtime_minutes": 10,
       "install_dir": "/home/u/.local/share/Steam/steamapps/common/vvvvvv", "library": "/home/u/.local/share/Steam",
       "compat_tool": "steamlinuxruntime_sniper", "compat_tool_display": "Steam Linux Runtime 3.0",
       "developer": "Terry Cavanagh", "platforms": ["linux"], "shortcut_exe": None, "shortcut_start_dir": None,
       "launch_options": "", "build_id": 1, "cloud": None, "running": False}
SHORTCUT = {**ROW, "appid": 4257405638, "name": "OpenTricky.exe", "app_type": 1073741824, "install_dir": "",
            "compat_tool": "", "compat_tool_display": "", "shortcut_exe": '"/x/OpenTricky.exe"',
            "shortcut_start_dir": '"/x/"', "installed_elsewhere": ["other-pc"]}


class FakeSteam:
    def __init__(self) -> None:
        self.running: list[int] = []
        self.calls: list[str] = []

    async def __call__(self, js: str):
        self.calls.append(js)
        if "RunGame(" in js:
            self.running.append(70300)
            return True
        if "TerminateApp(" in js:
            self.running.clear()
            return True
        if "GetActiveGameActions" in js:
            return json.dumps([])
        if "GetAppOverviewByAppID(" in js:
            if "GetAppOverviewByAppID(70300)" not in js:
                return json.dumps(None)
            return json.dumps({"steamid": "76561198055865200", "app": {**ROW, "running": 70300 in self.running}})
        if "appStore.allApps" in js:
            return json.dumps({"steamid": "76561198055865200", "apps": [SHORTCUT, ROW]})
        if "MainRunningAppID" in js:
            return json.dumps({"running": [{"appid": a, "name": "VVVVVV"} for a in self.running], "main": None})
        raise AssertionError(js[:200])


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
def test_generated_js_parses():
    scripts = {
        "list": apps_mod._LIST_JS.replace("__INSTALLED__", "true").replace("__TOOLS__", "false").replace("__QUERY__", '"x"'),
        "one": apps_mod._ONE_JS.replace("__APPID__", "70300"),
        "running": apps_mod._RUNNING_JS,
        "actions": apps_mod._ACTIONS_JS,
    }
    for name, js in scripts.items():
        assert "__" + "APPID" not in js
        # Runtime.evaluate runs each script in the same global scope, so helpers must not leak to top level.
        assert not js.lstrip().startswith("const"), name
        out = subprocess.run(["node", "--check", "-"], input=js, capture_output=True, text=True)
        assert out.returncode == 0, f"{name}: {out.stderr}"


def test_list_shapes_rows():
    data = asyncio.run(Apps(FakeSteam()).list(query="v"))
    assert data["count"] == 2 and [a["name"] for a in data["apps"]] == ["OpenTricky.exe", "VVVVVV"]
    short, game = data["apps"]
    assert game["type"] == "game" and game["compat_tool"] == "steamlinuxruntime_sniper"
    assert game["last_played"].startswith("2026-11-04") and "installed_elsewhere" not in game
    assert short["type"] == "shortcut" and short["compat_tool"] is None and short["install_dir"] == "/x/"
    assert short["installed_elsewhere"] == ["other-pc"]


def test_list_query_is_json_escaped():
    steam = FakeSteam()
    asyncio.run(Apps(steam).list(query='a"); alert(1); ("'))
    assert '"a\\"); alert(1); (\\""' in steam.calls[0]


@pytest.mark.parametrize("bad", [0, -5, "70300", True, 2 ** 32])
def test_bad_appid(bad):
    with pytest.raises(ValueError):
        asyncio.run(Apps(FakeSteam()).raw(bad))


def test_unknown_app():
    with pytest.raises(FileNotFoundError):
        asyncio.run(Apps(FakeSteam()).raw(12345))


def test_launch_and_terminate(monkeypatch):
    monkeypatch.setattr(apps_mod, "_proc_pids", lambda appid: [{"pid": 42, "cmdline": "reaper", "reaper": True}])
    steam = FakeSteam()
    lib = Apps(steam)
    res = asyncio.run(lib.launch(70300, wait=1))
    assert res == {"appid": 70300, "name": "VVVVVV", "launched": True, "running": True}
    assert any('RunGame("70300", \'\', -1, 100)' in c for c in steam.calls)
    assert asyncio.run(lib.running())["running"][0]["pid"] == 42
    with pytest.raises(ValueError, match="confirm"):
        asyncio.run(lib.terminate(70300))
    assert not any("TerminateApp" in c for c in steam.calls)
    res = asyncio.run(lib.terminate(70300, confirm=True, wait=1))
    assert res["terminated"] is True and any('TerminateApp("70300", false)' in c for c in steam.calls)
    assert asyncio.run(lib.terminate(70300, confirm=True))["note"] == "not running"


def test_launch_not_running_reports_actions():
    class Stuck(FakeSteam):
        async def __call__(self, js):
            if "RunGame(" in js:
                self.calls.append(js)
                return True
            return await super().__call__(js)
    res = asyncio.run(Apps(Stuck()).launch(70300, wait=0))
    assert res["running"] is False and res["game_actions"] == [] and "dialog" in res["note"]


def test_apps_routes(monkeypatch, tmp_path):
    monkeypatch.setenv("DECKY_USER_HOME", str(tmp_path))
    monkeypatch.setattr(apps_mod, "_proc_pids", lambda appid: [{"pid": 42, "cmdline": "reaper", "reaper": True}])
    steam = FakeSteam()
    monkeypatch.setattr(http_mod, "Apps", lambda: Apps(steam))

    async def run(s, base):
        async with s.get(f"{base}/api/v1/apps") as r:
            assert r.status == 401
        async with s.get(f"{base}/api/v1/apps?query=v", headers=H) as r:
            assert r.status == 200 and (await r.json())["count"] == 2
        async with s.get(f"{base}/api/v1/apps/70300/dirs", headers=H) as r:
            assert r.status == 200 and (await r.json())["appid"] == 70300
        async with s.get(f"{base}/api/v1/apps/70300/saves", headers=H) as r:
            assert r.status == 200 and (await r.json())["candidates"] == []
        async with s.get(f"{base}/api/v1/apps/12345/dirs", headers=H) as r:
            assert r.status == 404
        async with s.get(f"{base}/api/v1/apps/abc/dirs", headers=H) as r:
            assert r.status == 400
        async with s.post(f"{base}/api/v1/apps/70300/launch", json={"wait": 1}, headers=H) as r:
            assert r.status == 200 and (await r.json())["launched"] is True
        async with s.post(f"{base}/api/v1/apps/70300/terminate", json={"wait": 1}, headers=H) as r:
            assert r.status == 400 and "confirm" in (await r.json())["error"]
        async with s.post(f"{base}/api/v1/apps/70300/terminate", json={"confirm": True, "wait": 1}, headers=H) as r:
            assert r.status == 200 and (await r.json())["terminated"] is True
        async with s.post(f"{base}/api/v1/apps/70300/launch", json={"wait": 1, "x": 1}, headers=H) as r:
            assert r.status == 400
        async with s.get(f"{base}/api/v1/apps/70300/proton-log?lines=5", headers=H) as r:
            assert r.status == 200 and (await r.json())["appid"] == 70300
    asyncio.run(with_server(run))


def test_cef_evaluate_and_toast_routes(monkeypatch):
    seen = []

    async def evaluate_in(target, expression, timeout=15):
        seen.append((target, expression))
        return {"echo": expression} if target == "QuickAccess" else "ok"
    monkeypatch.setattr(cdp, "evaluate_in", evaluate_in)

    async def run(s, base):
        async with s.post(f"{base}/api/v1/cef/evaluate", json={"expression": "1+1", "target": "QuickAccess"}, headers=H) as r:
            assert await r.json() == {"value": {"echo": "1+1"}}
        async with s.post(f"{base}/api/v1/cef/evaluate", json={}, headers=H) as r:
            assert r.status == 400 and "expression" in (await r.json())["error"]
        async with s.post(f"{base}/api/v1/ui/toast", json={"title": "VS Code", "body": "hi"}, headers=H) as r:
            assert await r.json() == {"result": "ok"}
        assert '"VS Code"' in seen[-1][1] and "toaster" in seen[-1][1]
    asyncio.run(with_server(run))


def test_apps_route_without_steam(monkeypatch):
    async def down(js):
        raise cdp.CdpError("Steam CEF debugger not reachable")
    monkeypatch.setattr(http_mod, "Apps", lambda: Apps(down))

    async def run(s, base):
        async with s.get(f"{base}/api/v1/apps", headers=H) as r:
            assert r.status == 502
    asyncio.run(with_server(run))
