"""Ends streaming requests (MJPEG, websockets, SSE, long polls) when the HTTP server shuts down.

They never finish on their own, so aiohttp's graceful shutdown waits its full `shutdown_timeout` on
them, twice (4 s of the loader's 5 s before SIGKILL). Cancelling the handlers alone still left one
timeout; dropping the transport ends them at once. Clients see a dropped connection and reconnect.
"""
import asyncio
from typing import Awaitable, Callable

from aiohttp import web

Handler = Callable[[web.Request], Awaitable[web.StreamResponse]]


class LongLivedRequests:
    def __init__(self) -> None:
        self._active: dict[asyncio.Task, web.Request] = {}

    def __len__(self) -> int:
        return len(self._active)

    def track(self, handler: Handler) -> Handler:
        async def run(request: web.Request) -> web.StreamResponse:
            task = asyncio.current_task()
            self._active[task] = request
            try:
                return await handler(request)
            finally:
                self._active.pop(task, None)
        return run

    def install(self, app: web.Application) -> None:
        app.on_shutdown.append(self._close_all)

    async def _close_all(self, _app: web.Application) -> None:
        for task, request in list(self._active.items()):
            if request.transport is not None:
                request.transport.abort()
            task.cancel()
