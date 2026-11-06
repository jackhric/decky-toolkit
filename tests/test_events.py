"""The event hub and GET /api/v1/events: fan-out, slow subscribers, Decky panel events, hello, heartbeats, shutdown,
and the services that publish. Run with: ./scripts/test.sh"""
import asyncio
import json
import logging
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "py_modules"))

from aiohttp import ClientSession, ClientTimeout, web  # noqa: E402

import sse  # noqa: E402
from certauth import H, stub_auth  # noqa: E402
from decky_toolkit.media.capture import ScreenCapturer  # noqa: E402
from decky_toolkit.server.events import EventHub, frame  # noqa: E402
from decky_toolkit.server.http import Api  # noqa: E402
from decky_toolkit.server.protocol import McpServer  # noqa: E402
from decky_toolkit.settings import Settings  # noqa: E402
from decky_toolkit.tools import ToolRegistry, build_registry  # noqa: E402
from decky_toolkit.loader import plugins as plugin_ops  # noqa: E402
from decky_toolkit.tools.plugin_tools import PluginTools  # noqa: E402

LOG = logging.getLogger("t")


def drain(sub) -> list:
    out = []
    while not sub.queue.empty():
        out.append(sub.queue.get_nowait())
    return out


def test_publish_fans_out_and_skips_repeats():
    async def run():
        hub = EventHub()
        with hub.subscribe() as a, hub.subscribe() as b:
            assert len(hub) == 2
            hub.publish("tools", {"hash": "1"})
            hub.publish("tools", {"hash": "1"})
            hub.publish("tools", {"hash": "2"})
            want = [frame("tools", {"hash": "1"}), frame("tools", {"hash": "2"})]
            assert drain(a) == want and drain(b) == want
        assert len(hub) == 0 and a.closed.is_set()
    asyncio.run(run())


def test_frame_format():
    assert frame("tools", {"hash": "ab"}) == b'event: tools\ndata: {"hash":"ab"}\n\n'


def test_a_slow_subscriber_is_dropped_not_buffered():
    async def run():
        hub = EventHub(queue_size=3)
        with hub.subscribe() as slow, hub.subscribe() as fast:
            for i in range(3):
                hub.publish("tools", {"hash": str(i)})
                drain(fast)
            hub.publish("tools", {"hash": "3"})
            assert drain(slow) == [None], "its stream ends so it reconnects and resyncs from hello"
            assert drain(fast) == [frame("tools", {"hash": "3"})]
            assert len(hub) == 1
            hub.publish("tools", {"hash": "4"})
            assert drain(slow) == []
    asyncio.run(run())


def test_frontend_events_go_to_decky():
    emitted = []

    async def emit(name, *args):
        emitted.append((name, args))

    async def run():
        hub = EventHub(emit)
        hub.frontend("decky_toolkit_paired", "10.0.0.2", "laptop")
        await asyncio.sleep(0)
        assert emitted == [("decky_toolkit_paired", ("10.0.0.2", "laptop"))]
        EventHub().frontend("x")  # no emitter: nothing to do
    asyncio.run(run())


def test_refresh_reads_the_source_and_snapshot_skips_broken_ones():
    async def run():
        hub = EventHub()
        state = {"n": 1}

        async def pairing():
            return {"pending": state["n"]}

        def broken():
            raise RuntimeError("boom")
        hub.sources.update({"pairing": pairing, "input_settings": lambda: {"enabled": True}, "plugins": broken})
        assert await hub.snapshot() == {"pairing": {"pending": 1}, "input_settings": {"enabled": True}}
        with hub.subscribe() as sub:
            hub.refresh("pairing")
            hub.refresh("unknown")
            await asyncio.sleep(0.01)
            state["n"] = 2
            hub.refresh("pairing")
            hub.refresh("pairing")
            await asyncio.sleep(0.01)
            assert drain(sub) == [frame("pairing", {"pending": 1}), frame("pairing", {"pending": 2})]
    asyncio.run(run())


def test_on_subscribe_hooks_run_per_subscriber():
    hub = EventHub()
    calls = []
    hub.on_subscribe.append(lambda: calls.append(len(hub)))
    with hub.subscribe(), hub.subscribe():
        pass
    assert calls == [1, 2]


async def serve(hub: EventHub, heartbeat: float = 15.0):
    api = Api(auth=stub_auth(), mcp=McpServer(ToolRegistry(), LOG), capturer=None, logger=LOG, events=hub,
              heartbeat=heartbeat)
    runner = web.AppRunner(api.build_app(), shutdown_timeout=2)
    await runner.setup()
    await web.TCPSite(runner, "127.0.0.1", 0).start()
    return runner, f"http://127.0.0.1:{runner.addresses[0][1]}/api/v1/events"


def test_route_needs_a_paired_client_and_starts_with_hello():
    async def run():
        hub = EventHub()
        hub.sources["tools"] = lambda: {"hash": "abc"}
        runner, url = await serve(hub)
        try:
            async with ClientSession(timeout=ClientTimeout(total=5)) as s:
                async with s.get(url) as r:
                    assert r.status == 401
                async with s.get(url, headers=H) as r:
                    assert r.headers["Content-Type"].startswith("text/event-stream")
                    event, hello = await sse.next_event(r)
                    assert event == "hello" and hello["api"] == ["v1"] and hello["state"] == {"tools": {"hash": "abc"}}
                    assert isinstance(hello["version"], str)
                    hub.publish("stream_settings", {"fps": 30})
                    assert await sse.next_event(r) == ("stream_settings", {"fps": 30})
        finally:
            await runner.cleanup()
    asyncio.run(run())


def test_heartbeat_comments_keep_an_idle_stream_alive():
    async def run():
        runner, url = await serve(EventHub(), heartbeat=0.1)
        try:
            async with ClientSession(timeout=ClientTimeout(total=5)) as s, s.get(url, headers=H) as r:
                assert (await sse.next_event(r))[0] == "hello"
                t = time.monotonic()
                assert await sse.next_event(r, comments=True) == ("comment", None)
                assert await sse.next_event(r, comments=True) == ("comment", None)
                assert time.monotonic() - t < 1
        finally:
            await runner.cleanup()
    asyncio.run(run())


def test_shutdown_is_sent_and_the_server_stops_at_once():
    async def run():
        hub = EventHub()
        runner, url = await serve(hub)
        async with ClientSession(timeout=ClientTimeout(total=5)) as s, s.get(url, headers=H) as r:
            assert (await sse.next_event(r))[0] == "hello"
            assert len(hub) == 1
            t = time.monotonic()
            await runner.cleanup()
            assert time.monotonic() - t < 1, "long_lived ends the stream instead of waiting shutdown_timeout"
            assert await sse.next_event(r) == ("shutdown", {})
            assert (await r.content.read()) == b""
        assert len(hub) == 0
    asyncio.run(run())


def test_client_leaving_unsubscribes():
    async def run():
        hub = EventHub()
        runner, url = await serve(hub)
        try:
            async with ClientSession(timeout=ClientTimeout(total=5)) as s:
                async with s.get(url, headers=H) as r:
                    await sse.next_event(r)
                    assert len(hub) == 1
            for _ in range(40):
                if not len(hub):
                    break
                await asyncio.sleep(0.05)
            assert len(hub) == 0
        finally:
            await runner.cleanup()
    asyncio.run(run())


# ---- sources ----

def test_stream_settings_changes_are_reported():
    async def run():
        settings = Settings()
        cap = ScreenCapturer(lambda: settings, LOG)
        hub = EventHub()
        hub.sources["stream_settings"] = cap.stream_settings
        cap.on_settings_change = lambda: hub.refresh("stream_settings")
        with hub.subscribe() as sub:
            await cap.update_settings(fps=settings.stream_fps)
            await asyncio.sleep(0.01)
            assert drain(sub) == [], "no change, no event"
            await cap.update_settings(fps=15)
            await asyncio.sleep(0.01)
            [chunk] = drain(sub)
            assert chunk.startswith(b"event: stream_settings\n") and b'"fps":15' in chunk
    asyncio.run(run())


def test_plugin_tools_changes_refresh_the_tools_hash(tmp_path, monkeypatch):
    monkeypatch.setenv("DECKY_HOME", str(tmp_path))
    (tmp_path / "plugins" / "my-plugin").mkdir(parents=True)
    (tmp_path / "plugins" / "my-plugin" / "plugin.json").write_text(json.dumps({"name": "My Plugin"}))

    async def run():
        hub = EventHub()
        pt = PluginTools(LOG, events=hub)
        reg = build_registry(plugin_tools=pt, events=hub)
        hub.sources["tools"] = lambda: {"hash": reg.fingerprint()}
        with hub.subscribe() as sub:
            before = reg.fingerprint()
            pt._registered = [{"plugin": "My Plugin", "name": "reset", "description": "Reset."}]
            pt._resolve()
            await asyncio.sleep(0.01)
            pt._resolve()
            await asyncio.sleep(0.01)
            assert drain(sub) == [frame("tools", {"hash": reg.fingerprint()})] and reg.fingerprint() != before
    asyncio.run(run())


def test_plugin_install_refreshes_plugins(tmp_path, monkeypatch):
    async def run():
        hub = EventHub()
        reads = []
        hub.sources["plugins"] = lambda: reads.append(1) or {"plugins": []}
        monkeypatch.setattr(plugin_ops, "install_plugin_zip", lambda *a, **k: {"dir": "x", "name": "X", "version": "1"})
        reg = build_registry(events=hub)
        monkeypatch.setenv("DECKY_HOME", str(tmp_path))
        zip_path = tmp_path / "x.zip"
        zip_path.write_bytes(b"zip")
        res = await reg.call("plugin_install", {"path": str(zip_path), "restart": "none"})
        assert not res["isError"], res
        await asyncio.sleep(0.01)
        assert reads == [1]
    asyncio.run(run())
