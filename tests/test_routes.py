"""REST routes: /pair, /logs, /plugins, /stream/settings. Run with: ./scripts/test.sh"""
import asyncio
import io
import json
import logging
import os
import sys
import time
import zipfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "py_modules"))

from aiohttp import ClientSession, ClientTimeout, FormData, web  # noqa: E402

from decky_mcp.auth import TOKEN_COOKIE, TokenAuth  # noqa: E402
from decky_mcp.capture import ScreenCapturer  # noqa: E402
from decky_mcp.http import Api  # noqa: E402
from decky_mcp.protocol import McpServer  # noqa: E402
from decky_mcp.settings import Settings  # noqa: E402
from decky_mcp.tools import ToolRegistry, build_registry  # noqa: E402

TOKEN = "test-token"
H = {"Authorization": f"Bearer {TOKEN}"}
LOG = logging.getLogger("t")


@pytest.fixture
def decky_home(tmp_path, monkeypatch):
    monkeypatch.setenv("DECKY_HOME", str(tmp_path))
    (tmp_path / "plugins").mkdir()
    return tmp_path


class State:
    pairing = False
    paired: list[str] = []


async def with_server(fn, capturer=None, **api_kwargs):
    State.paired = []

    async def on_paired(remote: str) -> None:
        State.paired.append(remote)

    api = Api(auth=TokenAuth(TOKEN), mcp=McpServer(ToolRegistry(), LOG), capturer=capturer, static_dir=None, logger=LOG,
              pairing_open=lambda: State.pairing, on_paired=on_paired, base_url=lambda: "http://10.1.2.3:8765",
              **api_kwargs)
    runner = web.AppRunner(api.build_app())
    await runner.setup()
    await web.TCPSite(runner, "127.0.0.1", 0).start()
    base = f"http://127.0.0.1:{runner.addresses[0][1]}"
    try:
        async with ClientSession(timeout=ClientTimeout(total=10)) as s:
            await fn(s, base)
    finally:
        await runner.cleanup()


def write_log(home: Path, plugin: str, name: str, lines: list[str], mtime: float | None = None) -> Path:
    d = home / "logs" / plugin
    d.mkdir(parents=True, exist_ok=True)
    p = d / name
    p.write_text("".join(f"{l}\n" for l in lines))
    if mtime is not None:
        os.utime(p, (mtime, mtime))
    return p


def test_pair_open_and_closed():
    async def run(s, base):
        State.pairing = False
        async with s.get(f"{base}/pair") as r:
            assert r.status == 403 and await r.json() == {"error": "pairing closed"}
        State.pairing = True
        async with s.get(f"{base}/pair", headers={"Origin": "http://evil.example"}) as r:
            assert r.status == 403
        async with s.get(f"{base}/pair") as r:
            assert r.status == 200
            assert await r.json() == {"token": TOKEN, "url": "http://10.1.2.3:8765", "api_version": 1}
        assert State.paired == ["127.0.0.1"]
        State.pairing = False
        async with s.get(f"{base}/pair") as r:
            assert r.status == 403
        assert len(State.paired) == 1
    asyncio.run(with_server(run))


def test_logs_tail_plugin(decky_home):
    now = time.time()
    write_log(decky_home, "foo", "old.log", ["stale"], mtime=now - 100)
    write_log(decky_home, "foo", "new.log", [f"line {i}" for i in range(10)], mtime=now)

    async def run(s, base):
        async with s.get(f"{base}/logs/tail?source=plugin&plugin=foo&tail=3") as r:
            assert r.status == 401
        async with s.get(f"{base}/logs/tail?source=plugin&plugin=foo&tail=3", headers=H) as r:
            assert await r.json() == {"lines": ["line 7", "line 8", "line 9"]}
        async with s.get(f"{base}/logs/tail?plugin=foo&tail=1", headers=H) as r:
            assert await r.json() == {"lines": ["line 9"]}
        async with s.get(f"{base}/logs/tail?source=plugin&plugin=nope", headers=H) as r:
            assert r.status == 404
        async with s.get(f"{base}/logs/tail?source=plugin&plugin=../etc", headers=H) as r:
            assert r.status == 400
        async with s.get(f"{base}/logs/tail?source=plugin", headers=H) as r:
            assert r.status == 400
        async with s.get(f"{base}/logs/tail?source=bogus", headers=H) as r:
            assert r.status == 400
    asyncio.run(with_server(run))


def test_logs_stream_plugin(decky_home):
    path = write_log(decky_home, "foo", "a.log", ["one", "two", "three"], mtime=time.time() - 10)

    async def run(s, base):
        async with s.get(f"{base}/logs/stream?plugin=foo&tail=2", headers=H) as r:
            assert r.status == 200
            assert r.headers["Content-Type"].startswith("text/event-stream")
            assert r.headers["Cache-Control"] == "no-store" and r.headers["X-Accel-Buffering"] == "no"
            seen: list[str] = []

            async def read_until(pred):
                while not pred():
                    seen.append((await asyncio.wait_for(r.content.readline(), 5)).decode().rstrip("\n"))

            await read_until(lambda: ": keepalive" in seen)
            assert [l for l in seen if l.startswith("data:")] == ["data: two", "data: three"]
            with open(path, "a") as f:
                f.write("four\npart")
            await read_until(lambda: "data: four" in seen)
            # Decky opens a new file per plugin start; the follower switches to it.
            write_log(decky_home, "foo", "b.log", ["fresh"])
            await read_until(lambda: "data: fresh" in seen)
            assert "data: part" in seen
    asyncio.run(with_server(run, log_keepalive=0.2))


def test_logs_stream_stops_follower_on_disconnect(monkeypatch):
    from decky_mcp import logs

    closed = asyncio.Event()

    async def fake_follow(source, plugin, n):
        try:
            yield "hello"
            await asyncio.sleep(3600)
        finally:
            closed.set()

    monkeypatch.setattr(logs, "follow", fake_follow)

    async def run(s, base):
        async with s.get(f"{base}/logs/stream", headers=H) as r:
            assert (await r.content.readline()) == b"data: hello\n"
        await asyncio.wait_for(closed.wait(), 3)
    asyncio.run(with_server(run, log_keepalive=60))


def test_plugins_install_list_and_bearer_only(decky_home):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("thing/plugin.json", json.dumps({"name": "Thing", "author": "a", "flags": [], "api_version": 1}))
        zf.writestr("thing/package.json", json.dumps({"version": "0.1.0"}))
        zf.writestr("thing/main.py", "")

    def form():
        f = FormData()
        f.add_field("file", buf.getvalue(), filename="thing.zip", content_type="application/zip")
        return f

    async def run(s, base):
        async with s.post(f"{base}/plugins/install?restart=none", data=form(), cookies={TOKEN_COOKIE: TOKEN}) as r:
            assert r.status == 401
        async with s.post(f"{base}/plugins/install?restart=bogus", data=form(), headers=H) as r:
            assert r.status == 400
        async with s.post(f"{base}/plugins/install?restart=none", data=form(), headers=H) as r:
            assert r.status == 200, await r.text()
            assert await r.json() == {"installed": {"dir": "thing", "name": "Thing", "version": "0.1.0"}, "restarted": "none"}
        async with s.get(f"{base}/plugins", headers=H) as r:
            listed = await r.json()
            assert [(p["dir"], p["name"], p["version"]) for p in listed] == [("thing", "Thing", "0.1.0")]
        bad = FormData()
        bad.add_field("file", b"not a zip", filename="x.zip")
        async with s.post(f"{base}/plugins/install?restart=none", data=bad, headers=H) as r:
            assert r.status == 400 and "zip" in (await r.json())["error"]
        async with s.post(f"{base}/plugins/missing/reload", headers=H) as r:
            assert r.status == 404
    asyncio.run(with_server(run))


class FakeCapturer(ScreenCapturer):
    def __init__(self, running: bool):
        self.settings = Settings(token=TOKEN)
        self.saved = 0
        self.restarts = 0
        self.fake_running = running
        super().__init__(lambda: self.settings, LOG, save_settings=self._save)

    def _save(self) -> None:
        self.saved += 1

    @property
    def running(self) -> bool:
        return self.fake_running

    async def restart(self) -> None:
        self.restarts += 1


LIMITS = {"fps": [1, 60], "quality": [10, 100], "widths": [0, 1600, 1280, 960, 640]}


def test_stream_settings_get_put_and_clamp():
    cap = FakeCapturer(running=True)

    async def run(s, base):
        async with s.get(f"{base}/stream/settings") as r:
            assert r.status == 401
        async with s.get(f"{base}/stream/settings", headers=H) as r:
            assert await r.json() == {"fps": 30, "quality": 70, "width": 0, "limits": LIMITS}
        async with s.put(f"{base}/stream/settings", json={"fps": 60}, headers=H) as r:
            assert r.status == 200 and (await r.json())["fps"] == 60
        assert (cap.saved, cap.restarts) == (1, 1)
        async with s.put(f"{base}/stream/settings", json={"fps": 500, "quality": 3, "width": -5}, headers=H) as r:
            assert await r.json() == {"fps": 60, "quality": 10, "width": 0, "limits": LIMITS}
        async with s.put(f"{base}/stream/settings", json={"fps": 0, "quality": "95", "width": 1280}, headers=H) as r:
            assert await r.json() == {"fps": 1, "quality": 95, "width": 1280, "limits": LIMITS}
        assert cap.settings.stream_settings() == {"fps": 1, "quality": 95, "width": 1280}
        restarts = cap.restarts
        async with s.put(f"{base}/stream/settings", json={"fps": 1}, headers=H) as r:
            assert r.status == 200
        assert cap.restarts == restarts, "unchanged settings must not restart the pipeline"
        for bad in ({"fps": "fast"}, {"fps": True}, {"quality": None, "width": [1]}, {"bitrate": 5}, [1], "x"):
            async with s.put(f"{base}/stream/settings", json=bad, headers=H) as r:
                assert r.status == 400, bad
        async with s.put(f"{base}/stream/settings", data=b"{nope", headers=H) as r:
            assert r.status == 400
        # A rejected field must not half-apply the valid ones next to it.
        async with s.put(f"{base}/stream/settings", json={"fps": 24, "quality": "high"}, headers=H) as r:
            assert r.status == 400
        assert cap.settings.stream_fps == 1
    asyncio.run(with_server(run, capturer=cap))


def test_stream_settings_cookie_auth_and_origin():
    cap = FakeCapturer(running=False)

    async def run(s, base):
        cookies = {TOKEN_COOKIE: TOKEN}
        async with s.get(f"{base}/stream/settings", cookies=cookies) as r:
            assert r.status == 200
        async with s.put(f"{base}/stream/settings", json={"fps": 15}, cookies=cookies) as r:
            assert r.status == 200 and (await r.json())["fps"] == 15
        async with s.put(f"{base}/stream/settings", json={"fps": 20}, cookies=cookies,
                         headers={"Origin": "http://evil.example"}) as r:
            assert r.status == 403
        assert cap.settings.stream_fps == 15
    asyncio.run(with_server(run, capturer=cap))


def test_stream_settings_restart_only_when_running():
    idle = FakeCapturer(running=False)
    assert asyncio.run(idle.update_settings(fps=60))["fps"] == 60
    assert (idle.saved, idle.restarts) == (1, 0)
    live = FakeCapturer(running=True)
    asyncio.run(live.update_settings(width=640))
    assert (live.saved, live.restarts) == (1, 1)


def test_stream_settings_404_without_capturer():
    async def run(s, base):
        async with s.get(f"{base}/stream/settings", headers=H) as r:
            assert r.status == 404
        async with s.put(f"{base}/stream/settings", json={"fps": 60}, headers=H) as r:
            assert r.status == 404
    asyncio.run(with_server(run))


def test_set_stream_settings_tool_and_status():
    cap = FakeCapturer(running=True)
    reg = build_registry(cap)
    res = asyncio.run(reg.call("set_stream_settings", {"fps": 45, "quality": 80}))
    assert not res["isError"]
    assert json.loads(res["content"][0]["text"]) == {"fps": 45, "quality": 80, "width": 0, "limits": LIMITS}
    assert cap.restarts == 1
    bad = asyncio.run(reg.call("set_stream_settings", {"fps": "x"}))
    assert bad["isError"] and "fps must be an integer" in bad["content"][0]["text"]
    status = json.loads(asyncio.run(reg.call("stream_status", {}))["content"][0]["text"])
    assert status["settings"] == {"fps": 45, "quality": 80, "width": 0} and status["limits"] == LIMITS


def test_restart_keeps_subscribers_attached():
    class Proc:
        returncode = None

    class Cap(ScreenCapturer):
        def unavailable_reason(self):
            return None

        async def start(self):
            if self._proc is None:
                self._proc = Proc()

        async def stop(self):
            self._proc = None
            self._publish(b"late frame from the old pipeline")
            await asyncio.sleep(0.05)

    async def run():
        cap = Cap(lambda: Settings(token=TOKEN), LOG)
        agen = cap.subscribe()
        first = asyncio.ensure_future(agen.__anext__())
        await asyncio.sleep(0.01)
        cap._publish(b"one")
        assert await first == b"one"
        nxt = asyncio.ensure_future(agen.__anext__())
        restarting = asyncio.ensure_future(cap.restart())
        assert await nxt == b"late frame from the old pipeline"
        # Asked for the next frame while no pipeline is running: must wait, not end the stream.
        third = asyncio.ensure_future(agen.__anext__())
        await asyncio.sleep(0.01)
        assert not third.done()
        await restarting
        cap._publish(b"two")
        assert await third == b"two"
        await agen.aclose()
        if cap._idle_task:
            cap._idle_task.cancel()
    asyncio.run(run())
