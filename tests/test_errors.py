"""The exception table: every route answers the documented status and {"error", "code"?} body, and tools report the
same exceptions without a traceback (all but the OSError catch-all). Run with: ./scripts/test.sh"""
import asyncio

import pytest

from certauth import H, PUBLIC_KEY
from decky_toolkit import errors
from decky_toolkit.games.files import TooLarge
from decky_toolkit.input.service import InputDisabled, InputUnavailable
from decky_toolkit.media.capture import CaptureUnavailable, ScreenCapturer
from decky_toolkit.server.events import EventHub
from decky_toolkit.server.pairing import PairingLimit
from decky_toolkit.settings import Settings
from decky_toolkit.steam import cdp, ui
from decky_toolkit.tools import ToolRegistry
from harness import LOG, with_server

# What docs/api.md promises for each exception the shared functions raise.
DOCUMENTED = [
    (TooLarge("too big"), 413, "EFBIG"),
    (ValueError("bad"), 400, None),
    (PermissionError("refusing"), 403, "EACCES"),
    (FileNotFoundError("missing"), 404, "ENOENT"),
    (FileExistsError("exists"), 409, "EEXIST"),
    (IsADirectoryError("a dir"), 409, "EISDIR"),
    (NotADirectoryError("not a dir"), 409, "ENOTDIR"),
    (PairingLimit("too many"), 429, None),
    (cdp.CdpError("Steam CEF debugger not reachable"), 502, None),
    (InputUnavailable("no uinput"), 503, None),
    (InputDisabled("disabled"), 503, None),
    (CaptureUnavailable("no gamescope node"), 503, None),
    (OSError("disk on fire"), 500, None),
]


class Raising(ScreenCapturer):
    def __init__(self):
        super().__init__(lambda: Settings(), LOG, EventHub())
        self.error: BaseException = ValueError()

    async def grab(self) -> bytes:
        raise self.error


def test_every_row_is_documented():
    assert [(type(e), status, code) for e, status, code in DOCUMENTED] == list(errors.ERRORS)


@pytest.mark.parametrize("error,status,code", DOCUMENTED, ids=[type(e).__name__ for e, _, _ in DOCUMENTED])
def test_route_status_and_body(error, status, code):
    cap = Raising()
    cap.error = error

    async def run(s, base):
        async with s.get(f"{base}/api/v1/stream/frame", headers=H) as r:
            assert r.status == status
            assert await r.json() == {"error": str(error), **({"code": code} if code else {})}
    asyncio.run(with_server(run, capturer=cap))


@pytest.mark.parametrize("error,status,_code", DOCUMENTED, ids=[type(e).__name__ for e, _, _ in DOCUMENTED])
def test_tools_report_the_same_exceptions_without_a_traceback(error, status, _code):
    reg = ToolRegistry()

    @reg.add("raise_it", "Raise.")
    async def raise_it():
        raise error

    res = asyncio.run(reg.call("raise_it", {}))
    text = res["content"][0]["text"]
    assert res["isError"] and text.startswith(f"{type(error).__name__}: {error}")
    assert ("Traceback" in text) == (status == 500)


def test_documented_bodies_of_real_routes():
    async def down(js):
        raise cdp.CdpError("Steam CEF debugger not reachable")

    async def run(s, base):
        async with s.put(f"{base}/api/v1/stream/settings", json={"fps": "fast"}, headers=H) as r:
            assert r.status == 400 and set(await r.json()) == {"error"}
        async with s.put(f"{base}/api/v1/stream/settings", json={"bitrate": 1}, headers=H) as r:
            assert r.status == 400 and await r.json() == {"error": "unknown field(s): bitrate"}
        async with s.get(f"{base}/api/v1/fs/read", headers=H) as r:
            assert r.status == 400 and await r.json() == {"error": "path is required"}
        async with s.get(f"{base}/api/v1/ui/routes", headers=H) as r:
            assert r.status == 502 and await r.json() == {"error": "Steam CEF debugger not reachable"}
        async with s.post(f"{base}/api/v1/pair/request", data=b"nope") as r:
            assert r.status == 400 and await r.json() == {"error": "expected a JSON object"}
        async with s.get(f"{base}/api/v1/pair/request/x?wait=soon") as r:
            assert r.status == 400 and await r.json() == {"error": "wait must be a number of seconds"}
        body = {"client_name": "a", "client_kind": "vscode", "public_key": PUBLIC_KEY}
        for i in range(2):
            async with s.post(f"{base}/api/v1/pair/request", json={**body, "client_name": f"c{i}"}) as r:
                assert r.status == 201
        async with s.post(f"{base}/api/v1/pair/request", json=body) as r:
            assert r.status == 429
            assert await r.json() == {"error": "too many pending pairing requests from this address"}
        async with s.post(f"{base}/api/v1/plugins/install?restart=sometimes", headers=H) as r:
            assert r.status == 400 and "restart must be one of" in (await r.json())["error"]
    asyncio.run(with_server(run, ui=ui.UiNavigator(down, settle=0)))
