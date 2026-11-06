"""Audio capture fan-out and the /audio WebSocket. Run with: ./scripts/test.sh"""
import asyncio
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "py_modules"))

from aiohttp import WSMsgType  # noqa: E402

from decky_toolkit.media import audio as audio_mod  # noqa: E402
from decky_toolkit.media.audio import CHUNK_BYTES, FORMAT, MAX_BACKLOG_CHUNKS, AudioCapturer, AudioDisabled  # noqa: E402
from decky_toolkit.settings import Settings  # noqa: E402

from test_routes import H, FakeCapturer, with_server  # noqa: E402

LOG = logging.getLogger("t")


class FakeProc:
    def __init__(self) -> None:
        self.stdout = asyncio.StreamReader()
        self.stderr = asyncio.StreamReader()
        self.stderr.feed_eof()
        self.returncode = None
        self.signals: list[int] = []

    def send_signal(self, sig: int) -> None:
        self.signals.append(sig)
        self.returncode = 0
        self.stdout.feed_eof()

    def kill(self) -> None:
        self.send_signal(9)

    async def wait(self) -> int:
        while self.returncode is None:
            await asyncio.sleep(0.01)
        return self.returncode


class Cap(AudioCapturer):
    def __init__(self, settings: Settings, idle_stop: float = 10) -> None:
        super().__init__(lambda: settings, LOG, idle_stop=idle_stop)
        self.procs: list[FakeProc] = []

    def unavailable_reason(self):
        return None

    async def _spawn(self):
        self.procs.append(FakeProc())
        return self.procs[-1]


def chunk(i: int) -> bytes:
    return bytes([i % 256]) * CHUNK_BYTES


def test_chunking_and_fan_out():
    async def run():
        cap = Cap(Settings())
        a, b = cap.subscribe(), cap.subscribe()
        fa, fb = asyncio.ensure_future(a.__anext__()), asyncio.ensure_future(b.__anext__())
        await asyncio.sleep(0.02)
        assert len(cap.procs) == 1, "one pipeline for every subscriber"
        proc = cap.procs[0]
        # Chunk boundaries do not depend on how the pipe delivers bytes.
        data = chunk(1) + chunk(2) + chunk(3)
        proc.stdout.feed_data(data[:1000])
        proc.stdout.feed_data(data[1000:5000])
        proc.stdout.feed_data(data[5000:])
        assert await fa == chunk(1) and await fb == chunk(1)
        assert await a.__anext__() == chunk(2) and await a.__anext__() == chunk(3)
        assert cap.chunks_total == 3
        # b is slow: everything beyond the backlog cap drops the oldest chunks, never the newest.
        for i in range(4, 4 + MAX_BACKLOG_CHUNKS + 10):
            proc.stdout.feed_data(chunk(i))
        await asyncio.sleep(0.05)
        got = [await b.__anext__() for _ in range(MAX_BACKLOG_CHUNKS)]
        last = 3 + MAX_BACKLOG_CHUNKS + 10
        assert got[-1] == chunk(last) and got[0] == chunk(last - MAX_BACKLOG_CHUNKS + 1)
        proc.stdout.feed_data(b"partial")
        await asyncio.sleep(0.02)
        st = cap.stats()
        assert st["running"] and st["subscribers"] == 2 and st["chunks_total"] == last
        assert st["kbps"] > 0 and isinstance(st["rms_db"], float)
        await a.aclose()
        await b.aclose()
        await cap.stop()
        assert proc.signals == [2], "stopped with SIGINT"
        if cap._idle_task:
            cap._idle_task.cancel()
    asyncio.run(run())


def test_idle_stop_and_disable():
    async def run():
        settings = Settings()
        cap = Cap(settings, idle_stop=0.05)
        sub = cap.subscribe()
        first = asyncio.ensure_future(sub.__anext__())
        await asyncio.sleep(0.02)
        cap.procs[0].stdout.feed_data(chunk(7))
        assert await first == chunk(7)
        await sub.aclose()
        await asyncio.sleep(0.15)
        assert not cap.running, "pipeline stops once the last subscriber has been gone for idle_stop"

        sub = cap.subscribe()
        nxt = asyncio.ensure_future(sub.__anext__())
        await asyncio.sleep(0.02)
        assert cap.running and len(cap.procs) == 2
        settings.audio_enabled = False
        await cap.apply_enabled()
        try:
            await nxt
            raise AssertionError("expected AudioDisabled")
        except AudioDisabled:
            pass
        assert not cap.running
        try:
            await cap.subscribe().__anext__()
            raise AssertionError("expected AudioDisabled")
        except AudioDisabled:
            pass
    asyncio.run(run())


def test_falls_back_to_gamescope_sink():
    async def run():
        cap = Cap(Settings())
        sub = cap.subscribe()
        nxt = asyncio.ensure_future(sub.__anext__())
        await asyncio.sleep(0.02)
        first = cap.procs[0]
        cap._stderr.append("ERROR: stream error: target not found")
        first.returncode = 1
        first.stdout.feed_eof()
        await asyncio.sleep(0.05)
        assert len(cap.procs) == 2 and "target-object=gamescope" in cap._pipeline()
        cap.procs[1].stdout.feed_data(chunk(5))
        assert await nxt == chunk(5)
        await sub.aclose()
        await cap.stop()
        assert "target-object=gamescope" not in cap._pipeline(), "the next start tries the default sink again"
        if cap._idle_task:
            cap._idle_task.cancel()
    asyncio.run(run())


class FakeAudio(AudioCapturer):
    def __init__(self, settings: Settings) -> None:
        super().__init__(lambda: settings, LOG)
        self.feed: asyncio.Queue = asyncio.Queue()

    def unavailable_reason(self):
        return None

    async def subscribe(self):
        if not self.enabled:
            raise AudioDisabled("audio is disabled")
        q: asyncio.Queue = asyncio.Queue()
        self._subs.add(q)
        try:
            while True:
                item = await q.get()
                if item is audio_mod._DISABLED:
                    raise AudioDisabled("audio was disabled")
                yield item
        finally:
            self._subs.discard(q)


def test_audio_ws_format_chunks_and_disable():
    cap = FakeCapturer(running=False)
    aud = FakeAudio(cap.settings)
    cap.audio = aud

    async def run_ok(s, base):
        async with s.ws_connect(f"{base}/api/v1/audio", headers=H) as ws:
            assert await ws.receive_json(timeout=2) == FORMAT
            for _ in range(50):
                if aud._subs:
                    break
                await asyncio.sleep(0.01)
            for q in aud._subs:
                q.put_nowait(b"\x01\x02" * 1920)
            msg = await ws.receive(timeout=2)
            assert msg.type == WSMsgType.BINARY and len(msg.data) == CHUNK_BYTES
            async with s.get(f"{base}/api/v1/stream/stats", headers=H) as r:
                st = (await r.json())["audio"]
                assert st["enabled"] is True and st["format"]["rate"] == 48000
            async with s.put(f"{base}/api/v1/stream/settings", json={"audio": False}, headers=H) as r:
                assert r.status == 200 and (await r.json())["audio"] is False
            msg = await ws.receive(timeout=2)
            assert msg.type == WSMsgType.CLOSE and ws.close_code == 4003
        assert cap.settings.audio_enabled is False and cap.saved == 1
        async with s.ws_connect(f"{base}/api/v1/audio", headers=H) as ws:
            msg = await ws.receive(timeout=2)
            assert msg.type == WSMsgType.CLOSE and ws.close_code == 4003 and "disabled" in msg.extra
        async with s.put(f"{base}/api/v1/stream/settings", json={"audio": True}, headers=H) as r:
            assert (await r.json())["audio"] is True
        async with s.ws_connect(f"{base}/api/v1/audio", headers=H) as ws:
            assert (await ws.receive_json(timeout=2))["type"] == "format"
    asyncio.run(with_server(run_ok, capturer=cap, audio=aud))


def test_audio_ws_auth_and_404():
    async def run(s, base):
        async with s.get(f"{base}/api/v1/audio") as r:
            assert r.status == 401
        async with s.get(f"{base}/api/v1/audio", headers={**H, "Origin": "http://evil.example"}) as r:
            assert r.status == 403
    asyncio.run(with_server(run, audio=FakeAudio(Settings())))

    async def missing(s, base):
        async with s.get(f"{base}/api/v1/audio", headers=H) as r:
            assert r.status == 404
    asyncio.run(with_server(missing))
