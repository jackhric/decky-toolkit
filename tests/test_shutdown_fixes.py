"""loader_fixes and long_lived: plugin shutdown must not stall. Run with: ./scripts/test.sh"""
import asyncio
import logging
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "py_modules"))

from aiohttp import ClientSession, web  # noqa: E402

from decky_toolkit import loader_fixes  # noqa: E402
from decky_toolkit.long_lived import LongLivedRequests  # noqa: E402

LOG = logging.getLogger("t")


def make_socket_cls():
    # Same read loop as decky-loader v3.3.1 localsocket.UnixSocket.
    class Socket:
        active = True

        async def _read_single_line(self, reader):
            line = bytearray()
            while self.active:
                try:
                    line.extend(await reader.readuntil())
                except asyncio.IncompleteReadError as err:
                    line.extend(err.partial)
                    break
                else:
                    break
            return line.decode()

        async def listen(self, reader, seen, max_reads=1000):
            # Bounded so the unpatched spin ends: it never yields, so no timeout could stop it.
            while self.active and len(seen) < max_reads:
                seen.append(await self._read_single_line(reader))

    return Socket


async def run_listener(socket_cls) -> tuple[int, bool, list[str]]:
    """Ticks another task got while the listener ran at EOF, whether it was still running, and what it read."""
    reader = asyncio.StreamReader()
    reader.feed_data(b'{"id": 1}\n')
    reader.feed_eof()
    seen: list[str] = []
    ticks = 0

    async def ticker():
        nonlocal ticks
        while True:
            await asyncio.sleep(0.01)
            ticks += 1

    t = asyncio.create_task(ticker())
    listener = asyncio.create_task(socket_cls().listen(reader, seen))
    await asyncio.wait({listener}, timeout=0.2)
    ticks_then, running = ticks, not listener.done()
    t.cancel()
    listener.cancel()
    await asyncio.gather(t, listener, return_exceptions=True)
    return ticks_then, running, seen


def test_unpatched_reader_spins_without_yielding():
    ticks, running, seen = asyncio.run(run_listener(make_socket_cls()))
    assert not running and ticks == 0
    assert seen[0] == '{"id": 1}\n' and set(seen[1:]) == {""} and len(seen) == 1000


def test_patched_reader_yields_at_eof():
    cls = make_socket_cls()
    assert loader_fixes.patch_socket_eof(LOG, cls)
    ticks, running, seen = asyncio.run(run_listener(cls))
    assert running and ticks >= 10 and seen == ['{"id": 1}\n']


def test_patch_is_idempotent_and_never_raises():
    cls = make_socket_cls()
    assert loader_fixes.patch_socket_eof(LOG, cls)
    patched = cls._read_single_line
    assert loader_fixes.patch_socket_eof(LOG, cls)
    assert cls._read_single_line is patched
    assert not loader_fixes.patch_socket_eof(LOG, type("Renamed", (), {}))
    # Outside the loader the module does not exist.
    assert not loader_fixes.patch_socket_eof(LOG)


def test_shutdown_ends_streams_and_websockets_at_once():
    long_lived = LongLivedRequests()

    async def sse(request):
        res = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
        await res.prepare(request)
        try:
            while True:
                await res.write(b": keepalive\n\n")
                await asyncio.sleep(0.05)
        except asyncio.CancelledError:
            pass
        return res

    async def ws(request):
        sock = web.WebSocketResponse()
        await sock.prepare(request)
        try:
            async for _ in sock:
                pass
        except asyncio.CancelledError:
            pass
        return sock

    async def run():
        app = web.Application()
        long_lived.install(app)
        app.add_routes([web.get("/sse", long_lived.track(sse)), web.get("/ws", long_lived.track(ws))])
        runner = web.AppRunner(app, shutdown_timeout=2)
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        port = site._server.sockets[0].getsockname()[1]
        async with ClientSession() as session:
            stream = await session.get(f"http://127.0.0.1:{port}/sse")
            await stream.content.readline()
            sock = await session.ws_connect(f"http://127.0.0.1:{port}/ws")
            await asyncio.sleep(0.05)
            assert len(long_lived) == 2
            t = time.monotonic()
            await runner.cleanup()
            elapsed = time.monotonic() - t
            stream.close()
            await sock.close()
        assert len(long_lived) == 0
        return elapsed

    assert asyncio.run(run()) < 0.5
