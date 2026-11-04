"""Screen capture pipeline supervision: auto-restart on exit and on stall. Run with: ./scripts/test.sh"""
import asyncio
import logging
import signal
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "py_modules"))

from decky_toolkit import capture as capture_mod  # noqa: E402
from decky_toolkit.capture import ScreenCapturer, parse_node_info  # noqa: E402
from decky_toolkit.settings import Settings  # noqa: E402

from test_audio import FakeProc  # noqa: E402
from test_routes import TOKEN  # noqa: E402

LOG = logging.getLogger("t")


def part(data: bytes) -> bytes:
    return b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: " + str(len(data)).encode() + b"\r\n\r\n" + data + b"\r\n"


class Cap(ScreenCapturer):
    def __init__(self) -> None:
        super().__init__(lambda: Settings(token=TOKEN), LOG)
        self.procs: list[FakeProc] = []

    def unavailable_reason(self):
        return None

    async def _spawn(self):
        self.procs.append(FakeProc())
        return self.procs[-1]

    async def _gamescopectl(self, *args: str) -> None:
        pass

    async def _refresh_node_info(self) -> None:
        pass


def fast(monkeypatch) -> None:
    monkeypatch.setattr(capture_mod, "STALL_SECONDS", 0.3)
    monkeypatch.setattr(capture_mod, "FIRST_FRAME_SECONDS", 0.6)
    monkeypatch.setattr(capture_mod, "RESTART_BACKOFF", (0.05, 0.1, 0.2))


async def wait_for(cond, timeout: float = 2.0) -> None:
    end = asyncio.get_running_loop().time() + timeout
    while not cond():
        assert asyncio.get_running_loop().time() < end, "condition not met in time"
        await asyncio.sleep(0.01)


async def finish(cap: Cap, agen) -> None:
    await agen.aclose()
    await cap.stop()
    if cap._idle_task:
        cap._idle_task.cancel()


def test_restarts_when_pipeline_exits_with_subscribers(monkeypatch):
    fast(monkeypatch)

    async def run():
        cap = Cap()
        agen = cap.subscribe()
        first = asyncio.ensure_future(agen.__anext__())
        await wait_for(lambda: cap.procs)
        cap.procs[0].stdout.feed_data(part(b"one"))
        assert await first == b"one"
        nxt = asyncio.ensure_future(agen.__anext__())
        # gamescope renegotiated and gst-launch quit: the subscriber must wait, not end.
        cap.procs[0].returncode = 0
        cap.procs[0].stdout.feed_eof()
        await wait_for(lambda: len(cap.procs) == 2)
        assert not nxt.done()
        cap.procs[1].stdout.feed_data(part(b"two"))
        assert await nxt == b"two"
        st = cap.stats()
        assert st["restarts"] == 1 and "exited" in st["last_restart_reason"] and st["running"]
        await finish(cap, agen)
    asyncio.run(run())


def test_restarts_a_stalled_pipeline_with_sigint(monkeypatch):
    fast(monkeypatch)

    async def run():
        cap = Cap()
        agen = cap.subscribe()
        first = asyncio.ensure_future(agen.__anext__())
        await wait_for(lambda: cap.procs)
        cap.procs[0].stdout.feed_data(part(b"one"))
        assert await first == b"one"
        nxt = asyncio.ensure_future(agen.__anext__())
        # The process stays alive but goes quiet, as pipewiresrc does after gamescope renegotiates.
        await wait_for(lambda: len(cap.procs) == 2)
        assert cap.procs[0].signals == [signal.SIGINT], "never SIGTERM/SIGKILL: that can crash gamescope"
        assert not nxt.done()
        cap.procs[1].stdout.feed_data(part(b"two"))
        assert await nxt == b"two"
        assert cap.auto_restarts == 1 and "no frames" in cap.last_restart_reason
        await finish(cap, agen)
    asyncio.run(run())


def test_backoff_grows_while_no_frame_arrives_and_resets_on_success(monkeypatch):
    fast(monkeypatch)
    monkeypatch.setattr(capture_mod, "HEALTHY_SECONDS", 0.2)

    async def run():
        cap = Cap()
        agen = cap.subscribe()
        nxt = asyncio.ensure_future(agen.__anext__())
        # No pipeline ever produces a frame: each one is replaced after FIRST_FRAME_SECONDS + backoff.
        await wait_for(lambda: len(cap.procs) == 3, timeout=4)
        assert cap._backoff == 2 and not nxt.done()
        cap.procs[2].stdout.feed_data(part(b"finally"))
        assert await nxt == b"finally"

        async def feed():
            while True:
                cap.procs[-1].stdout.feed_data(part(b"x"))
                await asyncio.sleep(0.05)
        feeder = asyncio.ensure_future(feed())
        await wait_for(lambda: cap._backoff == 0)
        assert len(cap.procs) == 3
        feeder.cancel()
        await finish(cap, agen)
    asyncio.run(run())


def test_no_restart_without_subscribers(monkeypatch):
    fast(monkeypatch)

    async def run():
        cap = Cap()
        agen = cap.subscribe()
        first = asyncio.ensure_future(agen.__anext__())
        await wait_for(lambda: cap.procs)
        cap.procs[0].stdout.feed_data(part(b"one"))
        assert await first == b"one"
        await agen.aclose()
        cap.procs[0].returncode = 1
        cap.procs[0].stdout.feed_eof()
        await asyncio.sleep(0.3)
        assert len(cap.procs) == 1 and cap.auto_restarts == 0
        assert "exited (code 1)" in cap.stats()["error"]
        if cap._idle_task:
            cap._idle_task.cancel()
    asyncio.run(run())


def test_tick_lets_handlers_notice_a_stalled_stream(monkeypatch):
    fast(monkeypatch)
    monkeypatch.setattr(capture_mod, "TICK_SECONDS", 0.05)
    monkeypatch.setattr(capture_mod, "FIRST_FRAME_SECONDS", 60)

    async def run():
        cap = Cap()
        agen = cap.subscribe(tick=True)
        assert await asyncio.wait_for(agen.__anext__(), 1) == b""
        await finish(cap, agen)
    asyncio.run(run())


def test_parse_node_info():
    dump = [
        {"id": 68, "type": "PipeWire:Interface:Node", "info": {
            "props": {"node.name": "gamescope", "media.class": "Video/Source"},
            "params": {"Format": [{"format": "NV12", "size": {"width": 1920, "height": 1080},
                                   "id-00070000": {"width": 3840, "height": 2160}, "id-00070001": 70300}]}}},
        {"id": 76, "type": "PipeWire:Interface:Node", "info": {"props": {"node.name": "steam"}}},
        {"id": 111, "type": "PipeWire:Interface:Node", "info": {"props": {"node.name": "gst-launch-1.0"}}},
        {"id": 108, "type": "PipeWire:Interface:Link", "info": {"output-node-id": 68, "input-node-id": 76}},
        {"id": 93, "type": "PipeWire:Interface:Link", "info": {"output-node-id": 68, "input-node-id": 111}},
        {"id": 94, "type": "PipeWire:Interface:Link", "info": {"output-node-id": 54, "input-node-id": 111}},
    ]
    assert parse_node_info(dump) == {"node_id": 68, "format": "NV12", "width": 1920, "height": 1080,
                                     "focus_appid": 70300, "consumers": ["gst-launch-1.0", "steam"]}
    assert parse_node_info(dump[1:]) is None
    idle = [{"id": 68, "type": "PipeWire:Interface:Node", "info": {
        "props": {"node.name": "gamescope", "media.class": "Video/Source"}, "params": {}}}]
    assert parse_node_info(idle)["focus_appid"] == 0
