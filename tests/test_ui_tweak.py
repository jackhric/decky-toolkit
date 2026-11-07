"""ui_tweak and ui_react: argument and confirm rules, the saved off list, its route, and the page scripts. The frontend
registry itself is tested in tests/frontend (pnpm test). Run with: ./scripts/test.sh"""
import asyncio
import json
import re
import shutil
import subprocess

import pytest

from certauth import H
from decky_toolkit.server import audit
from decky_toolkit.server.events import EventHub
from decky_toolkit.settings import Settings
from decky_toolkit.steam import react as react_js
from decky_toolkit.steam.react import ReactInspector
from decky_toolkit.steam.tweaks import UiTweaks
from harness import LOG, make_registry, with_server


def run(coro):
    return asyncio.run(coro)


def text(r: dict) -> str:
    return r["content"][0]["text"]


class FakeFrontend:
    """window.__deckyToolkitSteam as the backend sees it through Runtime.evaluate."""

    def __init__(self, loaded: bool = True) -> None:
        self.loaded = loaded
        self.tweaks = {"top-bar-icon": "active", "transparent-header": "idle"}
        self.off: set[str] = set()
        self.scripts: list[str] = []

    def listing(self):
        return [{"name": n, "status": "off" if n in self.off else s} for n, s in self.tweaks.items()]

    async def __call__(self, js: str):
        self.scripts.append(js)
        if not self.loaded:
            return None
        if m := re.search(r"t\.setEnabled\((\"[^\"]*\"), (true|false)\)", js):
            name, on = json.loads(m.group(1)), m.group(2) == "true"
            names = list(self.tweaks) if name == "all" else [name]
            if name != "all" and name not in self.tweaks:
                return {"error": f'unknown tweak "{name}"'}
            for n in names:
                (self.off.discard if on else self.off.add)(n)
            return {"tweaks": self.listing(), "off": sorted(self.off)}
        if m := re.search(r"t\.try\((\"[^\"]*\"), function \(track\) \{\n(.*)\n\}, ([\d.]+)\)", js, re.S):
            return {"name": json.loads(m.group(1)), "status": "active", "trial": True, "reverts_at": 4102444800000}
        if "t.list()" in js:
            return self.listing()
        raise AssertionError(js)


@pytest.fixture
def setup():
    settings, saved, events = Settings(), [], EventHub(logger=LOG)
    emitted = []

    async def emit(*args):
        emitted.append(args)

    events._emit = emit
    front = FakeFrontend()
    tweaks = UiTweaks(lambda: settings, lambda: saved.append(list(settings.ui_tweaks_off)), events, LOG, evaluate=front)
    events.sources["ui_tweaks"] = tweaks.settings
    return {"settings": settings, "saved": saved, "emitted": emitted, "front": front, "tweaks": tweaks, "events": events}


def test_list_needs_no_confirm_and_switching_does(setup):
    reg = make_registry(tweaks=setup["tweaks"])
    r = run(reg.call("ui_tweak", {}))
    assert not r["isError"]
    assert json.loads(text(r)) == {"tweaks": [{"name": "top-bar-icon", "status": "active"},
                                              {"name": "transparent-header", "status": "idle"}], "off": []}
    for args in ({"action": "off", "name": "top-bar-icon"}, {"action": "on", "name": "all"},
                 {"action": "try", "code": "return () => {}"}):
        r = run(reg.call("ui_tweak", args))
        assert r["isError"] and "confirm: true" in text(r), args
    assert setup["front"].scripts == [setup["front"].scripts[0]], "nothing ran without confirm"
    assert "ui_tweak" in audit.AUDITED_TOOLS


def test_arguments_of_another_action_or_mode_are_refused(setup):
    reg = make_registry(tweaks=setup["tweaks"])
    r = run(reg.call("ui_tweak", {"action": "list", "name": "x"}))
    assert r["isError"] and "action 'list' does not take name (it takes nothing else)" in text(r)
    r = run(reg.call("ui_tweak", {"action": "off", "seconds": 5, "confirm": True}))
    assert r["isError"] and "does not take seconds" in text(r)
    r = run(reg.call("ui_tweak", {"action": "off", "confirm": True}))
    assert r["isError"] and "off needs name" in text(r)
    r = run(reg.call("ui_tweak", {"action": "try", "code": "x", "seconds": 301, "confirm": True}))
    assert r["isError"] and "seconds must be 1-300" in text(r)
    r = run(reg.call("ui_react", {"mode": "find", "selector": "#x", "grep": ["a"]}))
    assert r["isError"] and "mode 'find' does not take selector (it takes grep, limit)" in text(r)
    r = run(reg.call("ui_react", {"mode": "tree"}))
    assert r["isError"] and "tree needs selector" in text(r)
    r = run(reg.call("ui_react", {"mode": "patches", "ref": "1:a", "selector": "#x"}))
    assert r["isError"] and "ref (from find) or selector" in text(r)
    r = run(reg.call("ui_react", {"mode": "find", "grep": ["a"], "limit": 51}))
    assert r["isError"] and "limit must be an integer 1-50" in text(r)


def test_off_and_on_switch_the_frontend_and_save_what_it_reports(setup):
    reg = make_registry(tweaks=setup["tweaks"])
    r = json.loads(text(run(reg.call("ui_tweak", {"action": "off", "name": "top-bar-icon", "confirm": True}))))
    assert r["off"] == ["top-bar-icon"] and r["applied"] is True
    assert {"name": "top-bar-icon", "status": "off"} in r["tweaks"]
    assert setup["settings"].ui_tweaks_off == ["top-bar-icon"] and setup["saved"] == [["top-bar-icon"]]
    run(asyncio.sleep(0))
    assert ("decky_toolkit_ui_tweaks", ["top-bar-icon"]) in setup["emitted"]

    r = json.loads(text(run(reg.call("ui_tweak", {"action": "off", "name": "all", "confirm": True}))))
    assert r["off"] == ["top-bar-icon", "transparent-header"]
    r = json.loads(text(run(reg.call("ui_tweak", {"action": "on", "name": "all", "confirm": True}))))
    assert r["off"] == [] and setup["saved"][-1] == []

    r = run(reg.call("ui_tweak", {"action": "off", "name": "typo", "confirm": True}))
    assert r["isError"] and 'unknown tweak "typo"' in text(r)


def test_without_the_frontend_named_switches_are_saved_and_all_off_is_refused(setup):
    setup["front"].loaded = False
    reg = make_registry(tweaks=setup["tweaks"])
    r = json.loads(text(run(reg.call("ui_tweak", {"action": "off", "name": "top-bar-icon", "confirm": True}))))
    assert r["applied"] is False and r["off"] == ["top-bar-icon"] and "not loaded" in r["error"]
    r = run(reg.call("ui_tweak", {"action": "off", "name": "all", "confirm": True}))
    assert r["isError"] and "name one" in text(r)
    r = json.loads(text(run(reg.call("ui_tweak", {}))))
    assert r["tweaks"] is None and r["off"] == ["top-bar-icon"] and "plugin_reload" in r["error"]
    r = run(reg.call("ui_tweak", {"action": "try", "code": "return () => {}", "confirm": True}))
    assert r["isError"] and "not loaded" in text(r)


def test_try_wraps_the_body_and_reports_the_countdown(setup):
    reg = make_registry(tweaks=setup["tweaks"])
    body = "const p = DFL.afterPatch(o, 'f', (a, r) => r);\nreturn () => p.unpatch();"
    r = json.loads(text(run(reg.call("ui_tweak", {"action": "try", "code": body, "seconds": 5, "confirm": True}))))
    assert r["name"] == "trial" and r["status"] == "active" and r["reverts_in_s"] > 0 and "reverts_at" not in r
    assert f"function (track) {{\n{body}\n}}, 5)" in setup["front"].scripts[-1]
    setup["settings"].ui_tweaks_off = ["top-bar-icon"]
    r = run(reg.call("ui_tweak", {"action": "try", "name": "top-bar-icon", "code": "x", "confirm": True}))
    assert r["isError"] and "another name" in text(r)


def test_the_route_reads_and_replaces_the_saved_list(setup):
    async def check(s, base):
        url = f"{base}/api/v1/ui/tweaks"
        async with s.get(url, headers=H) as r:
            assert r.status == 200 and await r.json() == {"off": []}
        for bad in ({"off": "top-bar-icon"}, {"off": [1]}, {"off": [""]}, {"off": ["x" * 65]}, {}, {"off": [], "x": 1}):
            async with s.put(url, json=bad, headers=H) as r:
                assert r.status == 400, bad
        async with s.put(url, json={"off": ["b", "a", "b"]}, headers=H) as r:
            assert r.status == 200 and await r.json() == {"off": ["a", "b"]}
        with setup["events"].subscribe() as sub:
            async with s.put(url, json={"off": []}, headers=H) as r:
                assert await r.json() == {"off": []}
            await asyncio.sleep(0.05)
            assert b'event: ui_tweaks\ndata: {"off":[]}' in sub.queue.get_nowait()

    run(with_server(check, tweaks=setup["tweaks"]))
    assert setup["saved"] == [["a", "b"], []]
    run(asyncio.sleep(0))
    assert ("decky_toolkit_ui_tweaks", []) in setup["emitted"]


class FakeTabs:
    def __init__(self, result) -> None:
        self.result, self.calls = result, []

    async def __call__(self, target, js):
        self.calls.append((target, js))
        return self.result


def test_ui_react_targets_and_compact_tree_lines():
    find = FakeTabs({"total": 1, "matches": [{"ref": "84978:hB", "kind": "memo"}]})
    assert run(ReactInspector(find).find("quickAccessHeader"))["matches"][0]["ref"] == "84978:hB"
    assert find.calls[0][0] is None, "webpack modules live in SharedJSContext"
    assert '["quickAccessHeader"]' in find.calls[0][1]

    tree = FakeTabs({"target": "Steam Big Picture Mode", "selector": "#header", "up": [
        {"kind": "host", "level": 0, "tag": "div", "id": "header", "class": "GamepadMode"},
        {"kind": "memo", "level": 6, "simple_memo": True, "patched": ["top-bar-icon"], "src": "function(Ei){…"},
        {"kind": "class", "level": 7, "name": "h", "error_boundary": True, "key": "k"},
    ]})
    r = run(ReactInspector(tree).tree("#header"))
    assert tree.calls[0][0] == "Steam Big Picture Mode"
    assert r["up"] == ["0 <div#header> .GamepadMode", "6 memo(simple) patched=top-bar-icon src=function(Ei){…",
                       "7 class h key=k [error boundary]"]

    err = FakeTabs({"error": "no element matches #nope in Steam Big Picture Mode"})
    with pytest.raises(ValueError, match="no element matches"):
        run(ReactInspector(err).patches(selector="#nope"))


@pytest.mark.skipif(not shutil.which("node"), reason="needs node")
def test_page_scripts_parse(tmp_path):
    from decky_toolkit.steam import tweaks
    scripts = {
        "find": react_js._FIND_JS % (react_js._HELPERS, '["a"]', 10),
        "ref": react_js._PATCHES_REF_JS % (react_js._HELPERS, react_js._RESOLVE_JS % '"1:a"'),
        "fiber": react_js._FIBER_JS % (react_js._HELPERS, '"#x"', 10, 2, '"tree"', 80, 80),
        "tweak": tweaks._call("return t.list();"),
    }
    for name, js in scripts.items():
        path = tmp_path / f"{name}.js"
        path.write_text(js)
        r = subprocess.run(["node", "--check", str(path)], capture_output=True, text=True)
        assert r.returncode == 0, f"{name}: {r.stderr}"
