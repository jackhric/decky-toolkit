"""Device change events: the one path that tells clients (`GET /api/v1/events`) and the Decky panel what changed.

Each state event has a source that computes its current payload. `refresh(event)` recomputes it and publishes it only
when it differs from the last one, so callers may refresh whenever something might have changed. A new subscriber
gets every source in its `hello`.
"""
import asyncio
import contextlib
import inspect
import json
import logging
from typing import Any, Awaitable, Callable, Iterator

QUEUE_SIZE = 64
SHUTDOWN_GRACE_SECONDS = 0.5

Payload = dict[str, Any]
Source = Callable[[], Payload | Awaitable[Payload]]
Emit = Callable[..., Awaitable[Any]]


def frame(event: str, data: Payload) -> bytes:
    return f"event: {event}\ndata: {json.dumps(data, separators=(',', ':'), default=str)}\n\n".encode()


class Subscriber:
    def __init__(self, size: int):
        # Encoded frames; None ends the stream.
        self.queue: asyncio.Queue[bytes | None] = asyncio.Queue(size)
        self.closed = asyncio.Event()


class EventHub:
    def __init__(self, emit: Emit | None = None, logger: logging.Logger | None = None, queue_size: int = QUEUE_SIZE):
        self._emit = emit
        self.log = logger or logging.getLogger("decky_toolkit.events")
        self.queue_size = queue_size
        self.sources: dict[str, Source] = {}
        self._subs: set[Subscriber] = set()
        self._last: dict[str, bytes] = {}
        # Called when a subscriber arrives, for sources that only watch while someone listens.
        self.on_subscribe: list[Callable[[], None]] = []

    def __len__(self) -> int:
        return len(self._subs)

    def frontend(self, name: str, *args: Any) -> None:
        """A Decky event for this plugin's own panel (`addEventListener` in src/index.tsx)."""
        if self._emit is not None:
            asyncio.ensure_future(self._emit(name, *args))

    def publish(self, event: str, data: Payload) -> None:
        chunk = frame(event, data)
        if self._last.get(event) == chunk:
            return
        self._last[event] = chunk
        for sub in list(self._subs):
            self._put(sub, chunk)

    def refresh(self, event: str) -> None:
        if event in self.sources:
            asyncio.ensure_future(self._refresh(event))

    async def _refresh(self, event: str) -> None:
        if (data := await self._read(event)) is not None:
            self.publish(event, data)

    async def _read(self, event: str) -> Payload | None:
        try:
            data = self.sources[event]()
            return await data if inspect.isawaitable(data) else data
        except Exception as e:  # noqa: BLE001 - one broken source must not break the stream
            self.log.warning("event source %s failed: %s", event, e)
            return None

    async def snapshot(self) -> Payload:
        names = list(self.sources)
        values = await asyncio.gather(*(self._read(n) for n in names))
        return {n: v for n, v in zip(names, values) if v is not None}

    def _put(self, sub: Subscriber, chunk: bytes | None) -> None:
        try:
            sub.queue.put_nowait(chunk)
        except asyncio.QueueFull:
            # Too slow to keep up: end its stream so it reconnects and resyncs from hello.
            self.log.warning("event subscriber fell %d events behind; dropping it", self.queue_size)
            self._subs.discard(sub)
            while not sub.queue.empty():
                sub.queue.get_nowait()
            sub.queue.put_nowait(None)

    @contextlib.contextmanager
    def subscribe(self) -> Iterator[Subscriber]:
        sub = Subscriber(self.queue_size)
        self._subs.add(sub)
        for fn in self.on_subscribe:
            fn()
        try:
            yield sub
        finally:
            self._subs.discard(sub)
            sub.closed.set()

    async def close(self) -> None:
        """Send `shutdown` to every subscriber and give their streams a moment to write it."""
        subs = list(self._subs)
        for sub in subs:
            self._subs.discard(sub)
            while not sub.queue.empty():
                sub.queue.get_nowait()
            sub.queue.put_nowait(frame("shutdown", {}))
            sub.queue.put_nowait(None)
        if subs:
            waits = [asyncio.ensure_future(s.closed.wait()) for s in subs]
            _, pending = await asyncio.wait(waits, timeout=SHUTDOWN_GRACE_SECONDS)
            for w in pending:
                w.cancel()
