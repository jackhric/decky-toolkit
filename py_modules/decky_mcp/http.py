"""The aiohttp application: REST/viewer routes plus the mounted MCP endpoint."""
import asyncio
import logging
import os
from typing import Awaitable, Callable

from aiohttp import web

from .auth import TokenAuth
from .capture import BOUNDARY, CaptureUnavailable, ScreenCapturer
from .protocol import SERVER_INFO, McpServer

API_VERSION = 1

PairingOpen = Callable[[], bool]
OnPaired = Callable[[str], Awaitable[None]]


class Api:
    def __init__(self, *, auth: TokenAuth, mcp: McpServer, capturer: ScreenCapturer | None, static_dir: str | None,
                 logger: logging.Logger, pairing_open: PairingOpen | None = None, on_paired: OnPaired | None = None):
        self.auth = auth
        self.mcp = mcp
        self.capturer = capturer
        self.static_dir = static_dir
        self.log = logger
        self.pairing_open = pairing_open or (lambda: False)
        self.on_paired = on_paired

    def build_app(self) -> web.Application:
        app = web.Application(client_max_size=64 * 1024 * 1024, middlewares=[self.auth.middleware()])
        app.add_routes([
            web.get("/", self.handle_root),
            web.get("/health", self.handle_health),
            web.get("/viewer", self.handle_viewer),
            web.get("/stream.mjpeg", self.handle_stream),
            web.get("/frame.jpg", self.handle_frame),
            web.get("/stream/stats", self.handle_stream_stats),
            *self.mcp.routes(),
        ])
        return app

    # ---- public ----

    async def handle_root(self, _request: web.Request) -> web.Response:
        raise web.HTTPFound("/viewer")

    async def handle_health(self, _request: web.Request) -> web.Response:
        return web.json_response({"ok": True, **SERVER_INFO, "api_version": API_VERSION, "tools": len(self.mcp.tools)})

    # ---- viewer ----

    async def handle_viewer(self, request: web.Request) -> web.StreamResponse:
        presented = request.query.get("token")
        if presented is not None:
            if not self.auth.token_matches(presented):
                return web.Response(status=401, text="Bad token")
            # Move the token out of the address bar and into an HttpOnly cookie.
            res = web.HTTPFound("/viewer")
            self.auth.grant_cookie(res)
            raise res
        denied = self.auth.check(request)
        if denied and self.pairing_open():
            # Pairing window opened from the Decky panel: hand this browser the cookie, no token typing.
            self.log.info("pairing: granted viewer cookie to %s", request.remote)
            if self.on_paired:
                await self.on_paired(request.remote or "?")
            res = web.HTTPFound("/viewer")
            self.auth.grant_cookie(res)
            raise res
        if denied:
            return web.Response(
                status=401, content_type="text/html",
                text="<p>Unauthorized. Either open <code>/viewer?token=&lt;token&gt;</code> once, or press "
                     "<b>Pair a browser</b> in the Decky-MCP panel and reload this page within 120 seconds.</p>",
            )
        if not self.static_dir:
            return web.Response(status=404, text="viewer not bundled")
        return web.FileResponse(os.path.join(self.static_dir, "viewer.html"))

    async def handle_stream(self, request: web.Request) -> web.StreamResponse:
        if self.capturer is None:
            return web.Response(status=404, text="capture not available")
        res = web.StreamResponse(headers={
            "Content-Type": f"multipart/x-mixed-replace; boundary={BOUNDARY.decode()}",
            "Cache-Control": "no-store",
            "X-Accel-Buffering": "no",
        })
        await res.prepare(request)
        try:
            async for frame in self.capturer.subscribe():
                await res.write(b"--" + BOUNDARY + b"\r\nContent-Type: image/jpeg\r\nContent-Length: "
                                + str(len(frame)).encode() + b"\r\n\r\n" + frame + b"\r\n")
        except CaptureUnavailable as e:
            self.log.warning("stream ended: %s", e)
        except (ConnectionResetError, asyncio.CancelledError):
            pass
        return res

    async def handle_frame(self, _request: web.Request) -> web.Response:
        if self.capturer is None:
            return web.Response(status=404, text="capture not available")
        try:
            frame = await self.capturer.grab()
        except CaptureUnavailable as e:
            return web.Response(status=503, text=str(e))
        return web.Response(body=frame, content_type="image/jpeg", headers={"Cache-Control": "no-store"})

    async def handle_stream_stats(self, _request: web.Request) -> web.Response:
        if self.capturer is None:
            return web.json_response({"available": False, "error": "capture not available"})
        return web.json_response(self.capturer.stats())
