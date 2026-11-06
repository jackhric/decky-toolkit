"""ui_state and Orientation through the real registry, with fakes for the UI inspector, the input activity and the
capturer: the state, someone_at_device, one rule shared with device_activity, and failures. Run with: ./scripts/test.sh"""
import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "py_modules"))

from decky_toolkit.input.activity import AT_DEVICE_SECONDS  # noqa: E402
from decky_toolkit.steam import cdp, ui  # noqa: E402
from harness import make_registry  # noqa: E402
from test_controllers import FakeSteamUi  # noqa: E402

STATE = {"current": "/library/home", "side_menu": "none", "quick_access_tab": "decky", "active_plugin": None,
         "running_app": None, "dialog": None, "keyboard": False,
         "focus": {"text": "Play", "tag": "button", "target": "Steam Big Picture Mode"}}


class Inspector:
    def __init__(self, state=None, error: Exception | None = None):
        self.state, self.error, self.calls = state or dict(STATE), error, 0

    async def snapshot(self):
        self.calls += 1
        if self.error:
            raise self.error
        return dict(self.state)


class Activity:
    def __init__(self, ago: float | None):
        self.ago = ago

    def snapshot(self):
        last = None if self.ago is None else {"device": "Steam Deck", "at": 0, "seconds_ago": self.ago}
        return {"devices": [], "last": last}


class Capturer:
    def __init__(self):
        self.grabs = 0

    async def grab(self):
        self.grabs += 1
        return b"\xff\xd8jpeg"

    def stats(self):
        return {"width": 1920, "height": 1080, "subscribers": 0}


def call(reg, name, args=None):
    return asyncio.run(reg.call(name, args or {}))


def body(res):
    assert not res["isError"], res
    return json.loads(res["content"][0]["text"])


def test_ui_state_is_the_inspector_state_plus_someone_at_device():
    insp = Inspector()
    reg = make_registry(inspector=insp, activity=Activity(None))
    assert body(call(reg, "ui_state")) == {**STATE, "someone_at_device": False}
    assert insp.calls == 1
    reg = make_registry(inspector=Inspector(), activity=Activity(3))
    assert body(call(reg, "ui_state"))["someone_at_device"] is True


def test_ui_state_and_device_activity_agree():
    nav = ui.UiNavigator(FakeSteamUi(), settle=0)
    for ago, expected in ((AT_DEVICE_SECONDS - 1, True), (AT_DEVICE_SECONDS, True), (AT_DEVICE_SECONDS + 1, False)):
        reg = make_registry(inspector=Inspector(), activity=Activity(ago), ui=nav, capturer=Capturer())
        assert body(call(reg, "ui_state"))["someone_at_device"] is expected, ago
        assert body(call(reg, "device_activity"))["someone_at_device"] is expected, ago


def test_ui_state_reports_an_unreachable_steam_ui_as_an_expected_error():
    reg = make_registry(inspector=Inspector(error=cdp.CdpError("Steam CEF debugger not reachable")),
                        activity=Activity(None))
    res = call(reg, "ui_state")
    assert res["isError"] and res["content"][0]["text"] == "CdpError: Steam CEF debugger not reachable"


def test_screen_capture_carries_the_orientation_line():
    cap = Capturer()
    state = {**STATE, "running_app": {"appid": 70300, "name": "VVVVVV"}, "dialog": {"title": "Quit?"}}
    reg = make_registry(inspector=Inspector(state), activity=Activity(1), capturer=cap)
    text, image = call(reg, "screen_capture")["content"]
    assert image["type"] == "image" and cap.grabs == 1
    assert text["text"].splitlines()[1] == ("route /library/home · menu none · game VVVVVV · dialog Quit? · "
                                            "focus 'Play' · someone is using the device")
    reg = make_registry(inspector=Inspector(error=OSError("refused")), activity=Activity(None), capturer=Capturer())
    text, _ = call(reg, "screen_capture")["content"]
    assert text["text"].splitlines()[1] == "Steam UI state unavailable: refused", "a screenshot still comes back"
