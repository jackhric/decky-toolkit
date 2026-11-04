"""ui_query / ui_focus / ui_wait_for with a fake evaluator. Run with: ./scripts/test.sh"""
import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "py_modules"))

from decky_mcp import cdp  # noqa: E402
from decky_mcp.ui import UiInspector, UiTimeout, place_view, shape_element  # noqa: E402

# Measured on the device: Big Picture tab 1353x761 CSS px at dpr 1.42 on the 1920x1080 display;
# the Quick Access view 855x682 at (1005.5, 40) per GetBounds.
BPM = {"w": 1353, "h": 761, "sx": 0, "sy": 0, "sw": 1352, "sh": 760, "dpr": 1.42}
QAM = {"w": 855, "h": 682, "sx": 0, "sy": 0, "sw": 1352, "sh": 760, "dpr": 1.42}
QAM_BOUNDS = [{"x": 1005.52685546875, "y": 39.9978, "width": 853.99, "height": 681.27}]


def raw(rect, text="", shown=True, focused=False, **kw):
    return {"tag": "div", "id": None, "classes": ["Panel", "Focusable"], "text": text, "label": None,
            "rect": list(rect), "shown": shown, "focused": focused, **kw}


def test_shape_element_normalises_to_the_display():
    e = shape_element(raw((616.5, 200, 120, 60), text="  Play \n  now  ", focused=True), BPM)
    assert e["rect"] == {"x": 616.5, "y": 200.0, "width": 120.0, "height": 60.0}
    assert e["norm"] == {"x": round(676.5 / 1353, 4), "y": round(230 / 761, 4)}
    assert e["px"] == {"x": round(676.5 * 1.42), "y": round(230 * 1.42)}
    assert e["norm"]["x"] == 0.5 and e["text"] == "Play now" and e["visible"] and e["focused"]
    assert "label" not in e
    full = shape_element(raw((0, 0, 1353, 761)), BPM)
    assert full["norm"] == {"x": 0.5, "y": 0.5} and full["px"] == {"x": 961, "y": 540}

    assert not shape_element(raw((10, 10, 0, 20)), BPM)["visible"], "zero size"
    assert not shape_element(raw((10, 900, 50, 20)), BPM)["visible"], "below the viewport"
    assert not shape_element(raw((10, 10, 50, 20), shown=False), BPM)["visible"], "display:none / hidden"
    clipped = shape_element(raw((-100, 0, 200, 100)), BPM)
    assert clipped["visible"] and clipped["norm"]["x"] == round(50 / 1353, 4), "centre of the on-screen part"
    long = shape_element(raw((0, 0, 1, 1), text="x" * 500, label="Settings"), BPM)
    assert len(long["text"]) == 160 and long["label"] == "Settings"


def test_popup_views_are_placed_by_bounds():
    vp = place_view(QAM, QAM_BOUNDS)
    assert (vp["sx"], vp["sy"]) == (QAM_BOUNDS[0]["x"], QAM_BOUNDS[0]["y"])
    assert place_view(QAM, [{"x": 5, "y": 5, "width": 300, "height": 200}]) is QAM
    # "Bluetooth" row label in Quick Settings: measured at y ~542 px on the stream.
    e = shape_element(raw((64, 331.9, 214, 20)), vp)
    assert e["visible"] and e["px"]["y"] == 542 and 1519 < e["px"]["x"] < 1823
    assert e["norm"]["x"] == round((vp["sx"] + 64 + 107) / 1352, 4)
    # The view is 855 wide but only ~347 CSS px are on the display; the header is clipped at the edge.
    header = shape_element(raw((48, 14, 806, 34)), vp)
    assert header["visible"] and header["norm"]["x"] < 1
    assert not shape_element(raw((500, 14, 300, 34)), vp)["visible"], "entirely right of the display"


class FakePage:
    def __init__(self, responses, state=None):
        self.responses = responses
        self.calls = []
        self.state_value = state or {"current": "/library/home", "side_menu": "none"}

    async def evaluate(self, target, js):
        self.calls.append((target, js))
        key = "bounds" if "GetBounds" in js else "focus" if "gpfocus')]" in js else "query"
        r = self.responses[key]
        if isinstance(r, Exception):
            raise r
        return r(js) if callable(r) else r


class FakeNav:
    def __init__(self, page):
        self.page = page

    async def state(self):
        s = self.page.state_value
        return s() if callable(s) else s


def inspector(page):
    return UiInspector(FakeNav(page), evaluate=page.evaluate)


def test_query_shapes_sorts_and_validates():
    page = FakePage({"query": {"vp": BPM, "total": 3, "items": [
        raw((0, 0, 0, 0), text="hidden Settings"), raw((100, 100, 50, 20), text="Settings")]}})

    async def run():
        res = await inspector(page).query(text="Settings", limit=2)
        assert res["target"] == "Steam Big Picture Mode" and res["total"] == 3
        assert [e["text"] for e in res["elements"]] == ["Settings", "hidden Settings"]
        target, js = page.calls[0]
        assert target == "Steam Big Picture Mode" and '"Settings"' in js and "limit = 2" in js
        with pytest.raises(ValueError):
            await inspector(page).query()
        page.responses["query"] = cdp.CdpError("JS exception: Error: DMCP: invalid selector: 'div[' is not valid")
        with pytest.raises(ValueError, match="invalid selector"):
            await inspector(page).query(selector="div[")
    asyncio.run(run())


def test_query_in_quick_access_uses_view_bounds():
    page = FakePage({"query": {"vp": QAM, "total": 1, "items": [raw((64, 331.9, 214, 20), text="Bluetooth")]},
                     "bounds": QAM_BOUNDS})

    async def run():
        res = await inspector(page).query(text="Bluetooth", target="QuickAccess")
        assert res["elements"][0]["px"]["y"] == 542 and res["elements"][0]["visible"]
        assert [t for t, _ in page.calls] == ["QuickAccess", "SharedJSContext"]
    asyncio.run(run())


def test_focus_picks_gpfocus_and_side_menu_window():
    focused = raw((300, 200, 100, 100), text="2", focused=True)
    page = FakePage({"focus": {"vp": BPM, "window_focused": True, "gpfocus": [focused], "active": focused}})

    async def run():
        res = await inspector(page).focus()
        assert res["route"] == "/library/home" and res["target"] == "Steam Big Picture Mode"
        assert res["element"]["text"] == "2" and res["element"]["focused"]
        assert "active_element" not in res and "gpfocus" not in res

        page.state_value = {"current": "/library/home", "side_menu": "quick_access"}
        page.responses["focus"] = {"vp": QAM, "window_focused": True, "gpfocus": [raw((0, 245, 48, 64), focused=True)],
                                   "active": None}
        page.responses["bounds"] = QAM_BOUNDS
        res = await inspector(page).focus()
        assert res["target"] == "QuickAccess" and res["element"]["px"]["x"] == round((QAM_BOUNDS[0]["x"] + 24) * 1.42)

        page.state_value = {"current": "/settings", "side_menu": "none"}
        page.responses["focus"] = {"vp": BPM, "window_focused": False, "gpfocus": [],
                                   "active": raw((1, 1, 10, 10), text="input")}
        res = await inspector(page).focus()
        assert res["element"]["text"] == "input" and not res["window_focused"]
    asyncio.run(run())


def test_wait_for_element_route_gone_and_timeout():
    hits = iter([[], [], [raw((10, 10, 50, 20), text="Done")]])
    page = FakePage({"query": lambda js: {"vp": BPM, "total": 1, "items": next(hits, [raw((10, 10, 50, 20), text="Done")])},
                     "focus": {"vp": BPM, "window_focused": True, "gpfocus": [raw((5, 5, 10, 10), text="Here")], "active": None}})

    async def run():
        insp = inspector(page)
        res = await insp.wait_for(text="Done", timeout=2, interval=0.05)
        assert res["ok"] and res["element"]["text"] == "Done" and len(page.calls) == 3

        res = await insp.wait_for(route="/library/home/")
        assert res == {"ok": True, "elapsed_s": res["elapsed_s"], "route": "/library/home"}
        routes = iter(["/library/home", "/settings/system"])
        page.state_value = lambda: {"current": next(routes, "/settings/system"), "side_menu": "none"}
        assert (await insp.wait_for(route="/library/home", gone=True, interval=0.05))["route"] == "/settings/system"

        page.state_value = {"current": "/settings/system", "side_menu": "none"}
        with pytest.raises(UiTimeout) as err:
            await insp.wait_for(route="/library/home", timeout=0.2, interval=0.05)
        msg = str(err.value)
        assert "timed out after 0.2s waiting for route /library/home" in msg
        assert "current route /settings/system" in msg and "'Here'" in msg

        page.responses["query"] = cdp.CdpError("No CEF target")
        with pytest.raises(UiTimeout, match="last error: No CEF target"):
            await insp.wait_for(selector=".gone", timeout=0.1, interval=0.05)
        page.responses["query"] = {"vp": BPM, "total": 0, "items": []}
        assert (await insp.wait_for(selector=".gone", gone=True))["ok"]

        for bad in ({}, {"route": "/x", "text": "y"}):
            with pytest.raises(ValueError):
                await insp.wait_for(**bad)
    asyncio.run(run())
