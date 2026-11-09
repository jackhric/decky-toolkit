"""steam/ui_trace.py and the logs_* `ui` source: merging pages, per-page cursors, and the page script itself under
Node with a minimal fake DOM. Run with: ./scripts/test.sh"""
import asyncio
import json
import shutil
import subprocess

import pytest

from decky_toolkit.loader import logs
from decky_toolkit.steam import cdp
from decky_toolkit.steam.ui_trace import _JS, TARGETS, UiTrace
from decky_toolkit.tools import ToolRegistry
from decky_toolkit.tools import logs as log_tools


class FakePages:
    """Each target keeps [ts, text] events and a clock, like the page script."""

    def __init__(self):
        self.events = {"SharedJSContext": [[100.0, "route /library/home"], [130.0, "side_menu quick_access"]],
                       "QuickAccess": [[109.0, "quick_access visible"], [118.0, "quick_access hidden"]],
                       "MainMenu": []}
        self.now = {"SharedJSContext": 200.0, "QuickAccess": 190.0, "MainMenu": 210.0}
        self.down: set[str] = set()

    async def evaluate(self, target: str, js: str):
        if target in self.down:
            raise cdp.CdpError(f"No CEF target titled {target!r}\nmore")
        since = float(js.rsplit("})(", 1)[1].split(",", 1)[0])
        return {"since": 50.0, "now": self.now[target], "events": [e for e in self.events[target] if e[0] > since]}


def test_read_merges_pages_by_time_and_keeps_a_position_per_page():
    pages = FakePages()
    trace = UiTrace(pages.evaluate)
    out = asyncio.run(trace.read())
    assert [e["text"] for e in out["entries"]] == ["route /library/home", "quick_access visible",
                                                   "quick_access hidden", "side_menu quick_access"]
    assert [e["dt_ms"] for e in out["entries"]] == [None, 9.0, 9.0, 12.0]
    assert out["cursor"] == "200.000,190.000,210.000"
    # QuickAccess's clock lags; an event it stamps 195 still comes after its own position.
    pages.events["QuickAccess"].append([195.0, "quick_access visible"])
    pages.down.add("MainMenu")
    again = asyncio.run(trace.read(trace.parse_cursor(out["cursor"])))
    assert [e["text"] for e in again["entries"]] == ["quick_access visible"]
    assert again["cursor"].endswith(",210.000")
    assert again["recording"][2] == {"target": "MainMenu", "error": "No CEF target titled 'MainMenu'"}


def test_parse_cursor():
    assert UiTrace.parse_cursor("1,2,3") == [1.0, 2.0, 3.0]
    assert UiTrace.parse_cursor(5) == [5.0] * len(TARGETS)
    for bad in ("x", "1,2", "s=abc"):
        with pytest.raises(ValueError, match="not a ui cursor"):
            UiTrace.parse_cursor(bad)


def test_tool_marks_filters_and_waits():
    pages = FakePages()
    reg = ToolRegistry()

    class NoConsole:
        pass
    log_tools.register(reg, NoConsole(), UiTrace(pages.evaluate))  # type: ignore[arg-type]

    def call(name, args):
        res = asyncio.run(reg.call(name, args))
        assert not res["isError"], res
        return json.loads(res["content"][0]["text"])

    mark = call("logs_read", {"source": "ui", "lines": 0})
    assert mark["entries"] == [] and mark["cursor"] == "200.000,190.000,210.000"
    assert [e["text"] for e in call("logs_read", {"source": "ui", "match": "^quick_access", "lines": 1})["entries"]] \
        == ["quick_access hidden"]
    pages.events["QuickAccess"].append([191.0, "quick_access visible"])
    hit = call("logs_wait", {"source": "ui", "pattern": "quick_access visible", "since": mark["cursor"], "timeout": 1})
    assert hit["matched"] and hit["matches"][0]["text"] == "quick_access visible"
    assert asyncio.run(reg.call("logs_read", {"source": "ui", "plugin": "x"}))["isError"]


NODE_HARNESS = r"""
const listeners = {}, docListeners = {}, observers = [];
const el = (tag, text, cls) => ({tagName: tag, innerText: text, getAttribute: () => null,
  classList: {contains: (c) => cls.split(' ').includes(c)}});
const focused = el('BUTTON', 'Library', 'Panel gpfocus');
const document = {visibilityState: 'visible', documentElement: {}, querySelector: (s) => s === '.gpfocus' ? focused : null,
  addEventListener: (k, f) => { docListeners[k] = f; }};
let intervals = [];
const bw = {document, setInterval: (f) => intervals.push(f),
  addEventListener: (k, f) => { listeners[k] = f; },
  MutationObserver: class { constructor(f) { this.f = f; observers.push(this); } observe() {} }};
const store = {LocationPathName: '/library/home', m_BrowserWindow: bw,
  MenuStore: {GetOpenSideMenu: () => store.menu, GetQuickAccessTab: () => 999}, menu: 0};
globalThis.window = globalThis;
window.SteamUIStore = {WindowStore: {GamepadUIMainWindowInstance: store}};
const SCRIPT = process.argv[2];
const run = (since) => eval(SCRIPT.replace('__SINCE__', String(since)));
const first = run(0);
store.menu = 2; intervals.forEach((f) => f());
docListeners.visibilitychange();
const decky = el('DIV', 'Decky', 'Panel gpfocus');
observers[0].f([{target: decky, oldValue: 'Panel'}, {target: decky, oldValue: 'Panel Focusable'},
                {target: el('DIV', 'Decky', 'Panel gpfocus'), oldValue: 'Panel gpfocus'}]);
listeners.blur({target: el('DIV', '', '')});
listeners.blur({target: bw});
const second = run(first.now);
run(0);
console.log(JSON.stringify({first: first.events.map((e) => e[1]), second: second.events.map((e) => e[1]),
  intervals: intervals.length, observers: observers.length}));
"""


@pytest.mark.skipif(not shutil.which("node"), reason="needs node")
def test_page_script_records_state_focus_and_visibility(tmp_path):
    script = _JS % ("__SINCE__", "null", "true")
    harness = tmp_path / "harness.js"
    harness.write_text(NODE_HARNESS)
    out = json.loads(subprocess.run(["node", str(harness), script], capture_output=True, text=True, check=True).stdout)
    assert out["first"][:2] == ["big_picture visible", 'big_picture focus BUTTON "Library"']
    assert "route /library/home" in out["first"] and "side_menu none" in out["first"] and "panel none" in out["first"]
    assert "quick_access_tab decky" in out["first"]
    assert out["second"] == ["side_menu quick_access", "big_picture visible", 'big_picture focus DIV "Decky"',
                             "big_picture window blur"]
    # A second read installs nothing new.
    assert out["intervals"] == 1 and out["observers"] == 1


def test_wait_sources_include_ui():
    assert "ui" in logs.WAIT_SOURCES
