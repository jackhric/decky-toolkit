"""The aiohttp application: REST/viewer routes plus the mounted MCP endpoint."""
import asyncio
import json
import logging
import os
import tempfile
from typing import Awaitable, Callable

from aiohttp import web

from . import cdp, logs
from .audio import FORMAT as AUDIO_FORMAT, AudioCapturer, AudioDisabled, AudioUnavailable
from .auth import TokenAuth
from .capture import BOUNDARY, CaptureUnavailable, ScreenCapturer
from .input.ei import EiError
from .input.service import InputDisabled, InputService, InputUnavailable
from .protocol import SERVER_INFO, McpServer
from .tools import plugins
from .tools.system import list_plugins, schedule_loader_restart

API_VERSION = 1
LOG_KEEPALIVE_SECONDS = 15.0
INPUT_REFUSED = 4003
AUDIO_REFUSED = 4003
FOCUS_REFRESH_SECONDS = 3.0

PairingOpen = Callable[[], bool]
OnPaired = Callable[[str], Awaitable[None]]
BaseUrl = Callable[[], str]


def _error(status: int, message: str) -> web.Response:
    return web.json_response({"error": message}, status=status)


class Api:
    def __init__(self, *, auth: TokenAuth, mcp: McpServer, capturer: ScreenCapturer | None, static_dir: str | None,
                 logger: logging.Logger, pairing_open: PairingOpen | None = None, on_paired: OnPaired | None = None,
                 base_url: BaseUrl | None = None, log_keepalive: float = LOG_KEEPALIVE_SECONDS,
                 input_service: InputService | None = None, audio: AudioCapturer | None = None):
        self.auth = auth
        self.mcp = mcp
        self.capturer = capturer
        self.static_dir = static_dir
        self.log = logger
        self.pairing_open = pairing_open or (lambda: False)
        self.on_paired = on_paired
        self.base_url = base_url
        self.log_keepalive = log_keepalive
        self.input = input_service
        self.audio = audio

    def build_app(self) -> web.Application:
        app = web.Application(client_max_size=64 * 1024 * 1024, middlewares=[self.auth.middleware()])
        app.add_routes([
            web.get("/", self.handle_root),
            web.get("/health", self.handle_health),
            web.get("/pair", self.handle_pair),
            web.get("/viewer", self.handle_viewer),
            web.get("/stream.mjpeg", self.handle_stream),
            web.get("/frame.jpg", self.handle_frame),
            web.get("/stream/stats", self.handle_stream_stats),
            web.get("/stream/settings", self.handle_stream_settings_get),
            web.put("/stream/settings", self.handle_stream_settings_put),
            web.get("/audio", self.handle_audio_ws),
            web.get("/audio/stats", self.handle_audio_stats),
            web.get("/input", self.handle_input_ws),
            web.get("/input/settings", self.handle_input_settings_get),
            web.put("/input/settings", self.handle_input_settings_put),
            web.get("/plugins", self.handle_plugins),
            web.post("/plugins/install", self.handle_plugin_install),
            web.post("/plugins/{dir}/reload", self.handle_plugin_reload),
            web.post("/loader/restart", self.handle_loader_restart),
            web.get("/logs/tail", self.handle_logs_tail),
            web.get("/logs/stream", self.handle_logs_stream),
            *self.mcp.routes(),
        ])
        return app

    # ---- public ----

    async def handle_root(self, _request: web.Request) -> web.Response:
        raise web.HTTPFound("/viewer")

    async def handle_health(self, _request: web.Request) -> web.Response:
        return web.json_response({"ok": True, **SERVER_INFO, "api_version": API_VERSION, "tools": len(self.mcp.tools)})

    async def handle_pair(self, request: web.Request) -> web.Response:
        # Exempt from the auth middleware, so apply its Origin guard here: otherwise any web page a
        # LAN browser has open during the window could fetch the token.
        origin = request.headers.get("Origin")
        if origin and not self.auth.origin_allowed(origin, request.host):
            return _error(403, "origin not allowed")
        if not self.pairing_open():
            return _error(403, "pairing closed")
        self.log.info("pairing: granted token to %s", request.remote)
        if self.on_paired:
            await self.on_paired(request.remote or "?")
        url = self.base_url() if self.base_url else f"{request.scheme}://{request.host}"
        return web.json_response({"token": self.auth.token, "url": url, "api_version": API_VERSION},
                                 headers={"Cache-Control": "no-store"})

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

    # Cookie auth is enough here (the viewer changes these), and the setting is non-destructive.
    async def handle_stream_settings_get(self, _request: web.Request) -> web.Response:
        if self.capturer is None:
            return _error(404, "capture not available")
        return web.json_response(self.capturer.stream_settings())

    async def handle_stream_settings_put(self, request: web.Request) -> web.Response:
        if self.capturer is None:
            return _error(404, "capture not available")
        try:
            body = await request.json()
        except ValueError:
            return _error(400, "expected a JSON object")
        if not isinstance(body, dict):
            return _error(400, "expected a JSON object")
        unknown = set(body) - {"fps", "quality", "width", "audio"}
        if unknown:
            return _error(400, f"unknown field(s): {', '.join(sorted(unknown))}")
        try:
            return web.json_response(await self.capturer.update_settings(**body))
        except ValueError as e:
            return _error(400, str(e))

    # ---- audio ----

    async def handle_audio_stats(self, _request: web.Request) -> web.Response:
        if self.audio is None:
            return _error(404, "audio not available")
        return web.json_response(self.audio.stats())

    async def handle_audio_ws(self, request: web.Request) -> web.StreamResponse:
        if self.audio is None:
            return _error(404, "audio not available")
        ws = web.WebSocketResponse(heartbeat=20, max_msg_size=4096)
        await ws.prepare(request)
        if not self.audio.enabled:
            await ws.close(code=AUDIO_REFUSED, message=b"audio is disabled")
            return ws
        await ws.send_json(AUDIO_FORMAT)

        async def pump() -> None:
            try:
                async for chunk in self.audio.subscribe():
                    if ws.closed:
                        break
                    await ws.send_bytes(chunk)
            # A separate task: the handler cancels this pump once the receive loop ends, which would
            # abort a close handshake awaited here (the client then sees 1006 instead of the code).
            except AudioDisabled as e:
                asyncio.ensure_future(ws.close(code=AUDIO_REFUSED, message=str(e).encode()))
            except AudioUnavailable as e:
                self.log.warning("audio stream ended: %s", e)
                asyncio.ensure_future(ws.close(code=1011, message=str(e)[:120].encode()))
            except (ConnectionResetError, RuntimeError):
                pass

        # The receive loop notices the client leaving (and answers pings); the pump only sends.
        sender = asyncio.create_task(pump())
        try:
            async for _ in ws:
                pass
        except (ConnectionResetError, asyncio.CancelledError):
            pass
        finally:
            sender.cancel()
            await asyncio.gather(sender, return_exceptions=True)
        return ws

    # ---- input ----

    # Cookie auth is accepted on purpose: toggling input from the viewer should be one click.
    async def handle_input_settings_get(self, _request: web.Request) -> web.Response:
        if self.input is None:
            return _error(404, "input not available")
        return web.json_response(self.input.status())

    async def handle_input_settings_put(self, request: web.Request) -> web.Response:
        if self.input is None:
            return _error(404, "input not available")
        try:
            body = await request.json()
        except ValueError:
            return _error(400, "expected a JSON object")
        if not isinstance(body, dict) or "enabled" not in body:
            return _error(400, 'expected {"enabled": true|false}')
        unknown = set(body) - {"enabled"}
        if unknown:
            return _error(400, f"unknown field(s): {', '.join(sorted(unknown))}")
        try:
            return web.json_response(await self.input.set_enabled(body["enabled"]))
        except ValueError as e:
            return _error(400, str(e))

    async def handle_input_ws(self, request: web.Request) -> web.StreamResponse:
        if self.input is None:
            return _error(404, "input not available")
        svc = self.input
        ws = web.WebSocketResponse(heartbeat=20, max_msg_size=64 * 1024)
        await ws.prepare(request)
        # Refuse after the upgrade so browsers see the close code instead of a generic failure.
        if not svc.enabled or self.pairing_open():
            reason = "remote input is disabled" if not svc.enabled else "pairing window is open"
            await ws.close(code=INPUT_REFUSED, message=reason.encode())
            return ws
        session = svc.open_session(request.remote or "?")

        def on_state(state: dict) -> None:
            if ws.closed:
                return
            if not state["enabled"]:
                asyncio.ensure_future(ws.close(code=INPUT_REFUSED, message=b"remote input was disabled"))
            else:
                asyncio.ensure_future(ws.send_json(state))

        async def refresh_focus() -> None:
            while not ws.closed:
                await asyncio.sleep(FOCUS_REFRESH_SECONDS)
                await svc.focus_size()

        await svc.focus_size()
        await ws.send_json(svc.state())
        svc.add_listener(on_state)
        refresher = asyncio.create_task(refresh_focus())
        try:
            async for m in ws:
                if m.type != web.WSMsgType.TEXT:
                    continue
                try:
                    msg = json.loads(m.data)
                except ValueError:
                    await ws.send_json({"type": "error", "message": "invalid JSON"})
                    continue
                try:
                    await svc.handle(session, msg)
                except InputDisabled:
                    await ws.close(code=INPUT_REFUSED, message=b"remote input is disabled")
                    break
                except (ValueError, InputUnavailable, EiError, OSError) as e:
                    await ws.send_json({"type": "error", "message": str(e)})
                    continue
                # Optional extension: an "id" gets an ack, which lets clients measure round trips.
                if isinstance(msg, dict) and "id" in msg:
                    await ws.send_json({"type": "ack", "id": msg["id"]})
        except (ConnectionResetError, asyncio.CancelledError):
            pass
        finally:
            svc.remove_listener(on_state)
            refresher.cancel()
            await svc.close_session(session)
        return ws

    # ---- plugins ----

    def _require_bearer(self, request: web.Request) -> web.Response | None:
        # State-changing routes refuse the viewer cookie so a browser can never be steered into them.
        if self.auth.has_bearer(request):
            return None
        return web.Response(status=401, text="Bearer token required", headers={"WWW-Authenticate": 'Bearer realm="decky-mcp"'})

    async def handle_plugins(self, _request: web.Request) -> web.Response:
        return web.json_response(await list_plugins())

    async def handle_plugin_install(self, request: web.Request) -> web.Response:
        if denied := self._require_bearer(request):
            return denied
        restart = request.query.get("restart", "loader")
        if restart not in plugins.RESTART_MODES:
            return _error(400, f"restart must be one of {', '.join(plugins.RESTART_MODES)}")
        if not request.content_type.startswith("multipart/"):
            return _error(400, "expected multipart/form-data with a 'file' field")
        reader = await request.multipart()
        with tempfile.NamedTemporaryFile(prefix="decky-mcp-upload-", suffix=".zip") as tmp:
            found = False
            while (part := await reader.next()) is not None:
                if getattr(part, "name", None) != "file":
                    continue
                while chunk := await part.read_chunk(256 * 1024):
                    tmp.write(chunk)
                found = True
                break
            if not found:
                return _error(400, "missing multipart field 'file'")
            tmp.flush()
            try:
                result = await plugins.install(tmp.name, restart, self.log)
            except (ValueError, FileNotFoundError) as e:
                return _error(400, str(e))
            except cdp.CdpError as e:
                return _error(502, f"installed, but plugin reload failed: {e}")
        return web.json_response(result)

    async def handle_plugin_reload(self, request: web.Request) -> web.Response:
        if denied := self._require_bearer(request):
            return denied
        try:
            return web.json_response(await plugins.reload_plugin(request.match_info["dir"]))
        except ValueError as e:
            return _error(400, str(e))
        except FileNotFoundError as e:
            return _error(404, str(e))
        except cdp.CdpError as e:
            return _error(502, str(e))

    async def handle_loader_restart(self, request: web.Request) -> web.Response:
        if denied := self._require_bearer(request):
            return denied
        await schedule_loader_restart()
        return web.json_response({"restarting": True, "delay_s": 1})

    # ---- logs ----

    @staticmethod
    def _log_query(request: web.Request) -> tuple[str, str | None, int]:
        plugin = request.query.get("plugin") or None
        source = request.query.get("source") or ("plugin" if plugin else "loader")
        if source not in logs.SOURCES:
            raise ValueError(f"source must be one of {', '.join(logs.SOURCES)}")
        if source == "plugin":
            logs.plugin_log_dir(plugin or "")
        try:
            n = int(request.query.get("tail", logs.DEFAULT_TAIL))
        except ValueError:
            raise ValueError("tail must be an integer") from None
        return source, plugin, max(0, min(n, logs.MAX_TAIL))

    async def handle_logs_tail(self, request: web.Request) -> web.Response:
        try:
            source, plugin, n = self._log_query(request)
            lines = await logs.tail_lines(source, plugin, n)
        except ValueError as e:
            return _error(400, str(e))
        except FileNotFoundError as e:
            return _error(404, str(e))
        except RuntimeError as e:
            return _error(500, str(e))
        return web.json_response({"lines": lines})

    async def handle_logs_stream(self, request: web.Request) -> web.StreamResponse:
        try:
            source, plugin, n = self._log_query(request)
        except ValueError as e:
            return _error(400, str(e))
        if source == "plugin" and not os.path.isdir(logs.plugin_log_dir(plugin or "")):
            return _error(404, f"no log dir {logs.plugin_log_dir(plugin or '')}")
        res = web.StreamResponse(headers={
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Accel-Buffering": "no",
        })
        await res.prepare(request)
        lines = logs.follow(source, plugin, n)
        pending: asyncio.Future[str] | None = None
        loop = asyncio.get_running_loop()
        last_write = loop.time()
        try:
            while True:
                # Keep one __anext__ in flight across keepalive ticks: cancelling it on a timeout
                # would throw into the generator and kill the journalctl follower.
                if pending is None:
                    pending = asyncio.ensure_future(anext(lines))
                done, _ = await asyncio.wait({pending}, timeout=min(1.0, self.log_keepalive))
                if not done:
                    # aiohttp does not cancel handlers on disconnect, so poll the transport to stop
                    # the follower promptly instead of on the next failed keepalive write.
                    if request.transport is None or request.transport.is_closing():
                        break
                    if loop.time() - last_write >= self.log_keepalive:
                        await res.write(b": keepalive\n\n")
                        last_write = loop.time()
                    continue
                try:
                    line = pending.result()
                except StopAsyncIteration:
                    break
                finally:
                    pending = None
                await res.write(f"data: {line}\n\n".encode())
                last_write = loop.time()
        except (ConnectionResetError, asyncio.CancelledError):
            pass
        finally:
            if pending is not None:
                pending.cancel()
                await asyncio.gather(pending, return_exceptions=True)
            await lines.aclose()
        return res
