"""The aiohttp application: the client API under /api/v1 plus the mounted MCP endpoint.

Clients (the extension, the CLI) use these routes; agents use the MCP tools. Both call the same functions, so a
route returns what the matching tool computes, but the route shapes are the versioned contract.
"""
import asyncio
import json
import logging
import os
import tempfile

from aiohttp import web

from . import API_PREFIX, API_VERSIONS, audit
from ..steam import cdp
from ..games import files as games
from ..loader import live, logs
from .identity import identity
from ..media.audio import FORMAT as AUDIO_FORMAT, AudioCapturer, AudioDisabled, AudioUnavailable
from .auth import CertAuth
from ..media.capture import BOUNDARY, CaptureUnavailable, ScreenCapturer
from ..input.controllers import ControllerService
from ..input.ei import EiError
from ..input.service import InputDisabled, InputService, InputUnavailable
from .events import EventHub, frame
from .long_lived import LongLivedRequests
from .pairing import MAX_WAIT_SECONDS, POLL_AFTER_MS, PairingLimit, PairingRequests
from .protocol import SERVER_INFO, McpServer
from ..steam.apps import Apps
from ..steam.ui import UiNavigator
from ..tools import plugins
from ..tools.cef import toast
from ..tools.system import list_plugins, schedule_loader_restart

LOG_KEEPALIVE_SECONDS = 15.0
HEARTBEAT_SECONDS = 15.0
INPUT_REFUSED = 4003
AUDIO_REFUSED = 4003
FOCUS_REFRESH_SECONDS = 3.0

SSE_HEADERS = {"Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no"}


def _closed(request: web.Request) -> bool:
    return request.transport is None or request.transport.is_closing()


def _error(status: int, message: str) -> web.Response:
    return web.json_response({"error": message}, status=status)


@web.middleware
async def _not_found(request: web.Request, handler):
    # Runs before auth, so an outdated client learns why even before its certificate is checked.
    if isinstance(request.match_info.http_exception, web.HTTPNotFound):
        if request.path.startswith(API_PREFIX + "/"):
            return _error(404, "Not found")
        return _error(404, f"This client is older than the Decky Toolkit plugin {SERVER_INFO['version']}: update the "
                           "VS Code extension, or run npx decky-toolkit@latest")
    return await handler(request)


# First match wins, so subclasses come before their bases.
_STATUS = ((PermissionError, 403), (FileNotFoundError, 404), (ValueError, 400),
           (cdp.CdpError, 502), (InputUnavailable, 503), (CaptureUnavailable, 503))


async def _json(make, status: int = 200) -> web.Response:
    """Await `make()` and answer with its result, mapping the shared functions' exceptions to status codes."""
    try:
        return web.json_response(await make(), status=status)
    except tuple(t for t, _ in _STATUS) as e:
        return _error(next(code for t, code in _STATUS if isinstance(e, t)), str(e))


async def _body(request: web.Request, allowed: set[str]) -> dict:
    """The JSON object body (empty when there is none); unknown fields are a ValueError."""
    if not request.can_read_body:
        return {}
    try:
        body = await request.json()
    except (ValueError, UnicodeDecodeError):
        raise ValueError("expected a JSON object") from None
    if not isinstance(body, dict):
        raise ValueError("expected a JSON object")
    if unknown := set(body) - allowed:
        raise ValueError(f"unknown field(s): {', '.join(sorted(unknown))}")
    return body


async def _with_body(request: web.Request, allowed: set[str], fn, required: tuple[str, ...] = ()):
    body = await _body(request, allowed)
    if missing := [k for k in required if k not in body]:
        raise ValueError(f"missing field(s): {', '.join(missing)}")
    return await fn(**body)


def _appid(request: web.Request) -> int:
    raw = request.match_info["appid"]
    if not raw.isdigit() or int(raw) <= 0:
        raise ValueError("appid must be a positive integer")
    return int(raw)


class Api:
    def __init__(self, *, auth: CertAuth, mcp: McpServer, capturer: ScreenCapturer | None, logger: logging.Logger, pairing: PairingRequests | None = None, log_keepalive: float = LOG_KEEPALIVE_SECONDS,
                 input_service: InputService | None = None, audio: AudioCapturer | None = None,
                 controllers: ControllerService | None = None, ui: UiNavigator | None = None,
                 events: EventHub | None = None, heartbeat: float = HEARTBEAT_SECONDS):
        self.auth = auth
        self.mcp = mcp
        self.capturer = capturer
        self.log = logger
        self.pairing = pairing or PairingRequests()
        self.log_keepalive = log_keepalive
        self.input = input_service
        self.audio = audio
        self.controllers = controllers
        self.ui = ui
        self.events = events if events is not None else EventHub(logger=logger)
        self.heartbeat = heartbeat
        self._apps: Apps | None = None
        self.long_lived = LongLivedRequests()

    def build_app(self) -> web.Application:
        app = web.Application(client_max_size=64 * 1024 * 1024,
                              middlewares=[_not_found, self.auth.middleware(), audit.middleware(self.log)])
        # Before long_lived drops the transports, so event streams get to write `shutdown`.
        app.on_shutdown.append(lambda _app: self.events.close())
        self.long_lived.install(app)
        live = self.long_lived.track
        v1 = [
            web.post("/pair/request", self.handle_pair_request),
            web.get("/pair/request/{id}", live(self.handle_pair_poll)),
            web.delete("/pair/request/{id}", self.handle_pair_cancel),
            web.get("/stream", live(self.handle_stream)),
            web.get("/stream/frame", self.handle_frame),
            web.get("/stream/stats", self.handle_stream_stats),
            web.get("/stream/settings", self.handle_stream_settings_get),
            web.put("/stream/settings", self.handle_stream_settings_put),
            web.get("/audio", live(self.handle_audio_ws)),
            web.get("/input", live(self.handle_input_ws)),
            web.get("/input/settings", self.handle_input_settings_get),
            web.put("/input/settings", self.handle_input_settings_put),
            web.get("/controllers", self.handle_controllers),
            web.post("/controllers/virtual", self.handle_controller_add),
            web.delete("/controllers/virtual/{id}", self.handle_controller_remove),
            web.get("/events", live(self.handle_events)),
            web.get("/ui/routes", self.handle_ui_routes),
            web.post("/ui/navigate", self.handle_ui_navigate),
            web.post("/ui/toast", self.handle_ui_toast),
            web.post("/cef/evaluate", self.handle_cef_evaluate),
            web.get("/plugins", self.handle_plugins),
            web.post("/plugins/install", self.handle_plugin_install),
            web.post("/plugins/{dir}/reload", self.handle_plugin_reload),
            web.put("/plugins/{dir}/files", self.handle_plugin_file_put),
            web.post("/loader/restart", self.handle_loader_restart),
            web.get("/logs/tail", self.handle_logs_tail),
            web.get("/logs/stream", live(self.handle_logs_stream)),
            web.get("/apps", self.handle_apps),
            web.get("/apps/{appid}/dirs", self.handle_app_dirs),
            web.get("/apps/{appid}/saves", self.handle_app_saves),
            web.get("/apps/{appid}/proton-log", self.handle_app_proton_log),
            web.post("/apps/{appid}/launch", self.handle_app_launch),
            web.post("/apps/{appid}/terminate", self.handle_app_terminate),
            web.get("/fs", self.handle_fs),
            web.delete("/fs", self.handle_fs_delete),
            web.get("/fs/read", self.handle_fs_read),
            web.put("/fs/write", self.handle_fs_write),
            web.post("/fs/mkdir", self.handle_fs_mkdir),
            web.post("/fs/rename", self.handle_fs_rename),
        ]
        app.add_routes([
            web.get("/", self.handle_root),
            web.get("/health", self.handle_health),
            *[web.RouteDef(r.method, API_PREFIX + r.path, r.handler, r.kwargs) for r in v1],
            *self.mcp.routes(),
        ])
        return app

    # ---- public ----

    async def handle_root(self, _request: web.Request) -> web.Response:
        return web.Response(text="Decky Toolkit is running. Connect with the Decky Toolkit extension for VS Code / VSCodium.\n")

    async def handle_health(self, _request: web.Request) -> web.Response:
        return web.json_response({"ok": True, **SERVER_INFO, "api": list(API_VERSIONS), "tools": len(self.mcp.tools),
                                  "tools_hash": self.mcp.tools.fingerprint(), **identity()})

    # ---- pairing ----

    def _foreign_origin(self, request: web.Request) -> web.Response | None:
        # The request routes skip the auth middleware, so apply its Origin guard here: otherwise any
        # web page a LAN browser has open could file requests or read an approved certificate.
        origin = request.headers.get("Origin")
        if origin and not self.auth.origin_allowed(origin, request.host):
            return _error(403, "origin not allowed")
        return None

    async def handle_pair_request(self, request: web.Request) -> web.Response:
        if denied := self._foreign_origin(request):
            return denied
        try:
            body = await request.json()
        except ValueError:
            return _error(400, "expected a JSON object")
        if not isinstance(body, dict):
            return _error(400, "expected a JSON object")
        try:
            req = self.pairing.create(body.get("client_name"), body.get("client_kind", "other"), body.get("public_key"),
                                      request.remote or "?")
        except ValueError as e:
            return _error(400, str(e))
        except PairingLimit as e:
            return _error(429, str(e))
        self.log.info("pairing: request %s from %s (%s, %s)", req.code, req.remote, req.client_name, req.client_kind)
        return web.json_response({"id": req.id, "code": req.code, "poll_after_ms": POLL_AFTER_MS}, status=201,
                                 headers={"Cache-Control": "no-store"})

    async def handle_pair_poll(self, request: web.Request) -> web.StreamResponse:
        if denied := self._foreign_origin(request):
            return denied
        request_id = request.match_info["id"]
        try:
            wait = max(0.0, min(MAX_WAIT_SECONDS, float(request.query.get("wait", 0))))
        except ValueError:
            return _error(400, "wait must be a number of seconds")
        req = self.pairing.touch(request_id)
        if req is not None and wait:
            await self.pairing.wait(req, wait)
        req = self.pairing.touch(request_id)
        if req is None:
            return _error(404, "unknown or expired pairing request")
        no_store = {"Cache-Control": "no-store"}
        if self.pairing.claim_credentials(req):
            self.log.info("pairing: delivered credentials to %s (%s)", req.remote, req.client_name)
            return web.json_response({"status": "approved", "client_cert": req.client_cert,
                                      "server_cert": self.pairing.server_cert},
                                     headers=no_store)
        return web.json_response({"status": req.status}, headers=no_store)

    async def handle_pair_cancel(self, request: web.Request) -> web.Response:
        if denied := self._foreign_origin(request):
            return denied
        if not self.pairing.cancel(request.match_info["id"]):
            return _error(404, "no pending pairing request with that id")
        return web.json_response({"cancelled": True})

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
            with self.auth.connections.watching_screen():
                async for frame in self.capturer.subscribe(tick=True):
                    if not frame:
                        if request.transport is None or request.transport.is_closing():
                            break
                        continue
                    await res.write(b"--" + BOUNDARY + b"\r\nContent-Type: image/jpeg\r\nContent-Length: "
                                    + str(len(frame)).encode() + b"\r\n\r\n" + frame + b"\r\n")
        except CaptureUnavailable as e:
            self.log.warning("stream ended: %s", e)
        except (ConnectionResetError, asyncio.CancelledError):
            pass
        return res

    async def handle_frame(self, _request: web.Request) -> web.Response:
        if self.capturer is None:
            return _error(404, "capture not available")
        try:
            frame = await self.capturer.grab()
        except CaptureUnavailable as e:
            return _error(503, str(e))
        return web.Response(body=frame, content_type="image/jpeg", headers={"Cache-Control": "no-store"})

    async def handle_stream_stats(self, _request: web.Request) -> web.Response:
        if self.capturer is None:
            return web.json_response({"available": False, "error": "capture not available"})
        return web.json_response(self.capturer.stats())

    async def handle_stream_settings_get(self, _request: web.Request) -> web.Response:
        if self.capturer is None:
            return _error(404, "capture not available")
        return web.json_response(self.capturer.stream_settings())

    async def handle_stream_settings_put(self, request: web.Request) -> web.Response:
        if (capturer := self.capturer) is None:
            return _error(404, "capture not available")
        return await _json(lambda: _with_body(request, {"fps", "quality", "width", "audio"}, capturer.update_settings))

    # ---- audio ----

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

    async def handle_input_settings_get(self, _request: web.Request) -> web.Response:
        if self.input is None:
            return _error(404, "input not available")
        return web.json_response(self.input.status())

    async def handle_input_settings_put(self, request: web.Request) -> web.Response:
        if (svc := self.input) is None:
            return _error(404, "input not available")
        return await _json(lambda: _with_body(request, {"enabled"}, svc.set_enabled, ("enabled",)))

    async def handle_input_ws(self, request: web.Request) -> web.StreamResponse:
        if self.input is None:
            return _error(404, "input not available")
        svc = self.input
        ws = web.WebSocketResponse(heartbeat=20, max_msg_size=64 * 1024)
        await ws.prepare(request)
        # Refuse after the upgrade so browsers see the close code instead of a generic failure.
        if not svc.enabled:
            await ws.close(code=INPUT_REFUSED, message=b"remote input is disabled")
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

    # ---- controllers ----

    async def handle_controllers(self, _request: web.Request) -> web.Response:
        if self.controllers is None:
            return _error(404, "controllers not available")
        return await _json(self.controllers.snapshot)

    async def handle_controller_add(self, request: web.Request) -> web.Response:
        if (controllers := self.controllers) is None:
            return _error(404, "controllers not available")
        return await _json(lambda: _with_body(request, {"name"}, controllers.add_virtual), status=201)

    async def handle_controller_remove(self, request: web.Request) -> web.Response:
        if self.controllers is None:
            return _error(404, "controllers not available")
        pad_id = request.match_info["id"]
        if not self.controllers.remove_virtual(pad_id):
            return _error(404, f"no virtual gamepad {pad_id!r}")
        return web.json_response({"removed": pad_id})

    # ---- events ----

    async def handle_events(self, request: web.Request) -> web.StreamResponse:
        res = web.StreamResponse(headers=SSE_HEADERS)
        await res.prepare(request)
        loop = asyncio.get_running_loop()
        with self.events.subscribe() as sub:
            try:
                await res.write(frame("hello", {"version": SERVER_INFO["version"], "api": list(API_VERSIONS),
                                                "state": await self.events.snapshot()}))
                last_write = loop.time()
                while True:
                    try:
                        # aiohttp does not cancel handlers on disconnect, so wake up to look at the transport.
                        chunk = await asyncio.wait_for(sub.queue.get(), min(1.0, self.heartbeat))
                    except asyncio.TimeoutError:
                        if _closed(request):
                            break
                        if loop.time() - last_write >= self.heartbeat:
                            await res.write(b": heartbeat\n\n")
                            last_write = loop.time()
                        continue
                    if chunk is None:
                        break
                    await res.write(chunk)
                    last_write = loop.time()
            except (ConnectionResetError, asyncio.CancelledError):
                pass
        return res

    # ---- steam ui ----

    async def handle_ui_routes(self, _request: web.Request) -> web.Response:
        if self.ui is None:
            return _error(404, "ui navigation not available")
        return await _json(self.ui.routes)

    async def handle_ui_navigate(self, request: web.Request) -> web.Response:
        if (ui := self.ui) is None:
            return _error(404, "ui navigation not available")
        return await _json(lambda: _with_body(request, {"path", "action", "tab", "plugin", "appid"}, ui.navigate))

    async def handle_ui_toast(self, request: web.Request) -> web.Response:
        async def run(title: str, body: str, duration_ms: int = 5000) -> dict:
            return {"result": await toast(title, body, duration_ms)}
        return await _json(lambda: _with_body(request, {"title", "body", "duration_ms"}, run, ("title", "body")))

    async def handle_cef_evaluate(self, request: web.Request) -> web.Response:
        async def run(expression: str, target: str | None = None, timeout: float = 15) -> dict:
            return {"value": await cdp.evaluate_in(target, expression, timeout=timeout)}
        return await _json(lambda: _with_body(request, {"expression", "target", "timeout"}, run, ("expression",)))

    # ---- plugins ----

    async def handle_plugins(self, _request: web.Request) -> web.Response:
        return await _json(list_plugins)

    async def handle_plugin_reload(self, request: web.Request) -> web.Response:
        mode = request.query.get("mode", "backend")
        return await _json(lambda: live.reload(request.match_info["dir"], mode))

    async def handle_loader_restart(self, _request: web.Request) -> web.Response:
        await schedule_loader_restart()
        return web.json_response({"restarting": True, "delay_s": 1})

    async def handle_plugin_install(self, request: web.Request) -> web.Response:
        restart = request.query.get("restart", "loader")
        if restart not in plugins.RESTART_MODES:
            return _error(400, f"restart must be one of {', '.join(plugins.RESTART_MODES)}")
        if not request.content_type.startswith("multipart/"):
            return _error(400, "expected multipart/form-data with a 'file' field")
        reader = await request.multipart()
        with tempfile.NamedTemporaryFile(prefix="decky-toolkit-upload-", suffix=".zip") as tmp:
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
                result = await plugins.install(tmp.name, restart, self.log, self.events)
            except (ValueError, FileNotFoundError) as e:
                return _error(400, str(e))
            except cdp.CdpError as e:
                return _error(502, f"installed, but plugin reload failed: {e}")
        return web.json_response(result)

    async def handle_plugin_file_put(self, request: web.Request) -> web.Response:
        rel = request.query.get("path", "")
        data = await request.read()
        try:
            return web.json_response(await asyncio.to_thread(live.write_file, request.match_info["dir"], rel, data))
        except ValueError as e:
            return _error(400, str(e))
        except PermissionError as e:
            return _error(403, str(e))
        except FileNotFoundError as e:
            return _error(404, str(e))

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
        async def tail() -> dict:
            source, plugin, n = self._log_query(request)
            return {"lines": await logs.tail_lines(source, plugin, n)}
        return await _json(tail)

    async def handle_logs_stream(self, request: web.Request) -> web.StreamResponse:
        try:
            source, plugin, n = self._log_query(request)
        except ValueError as e:
            return _error(400, str(e))
        if source == "plugin" and not os.path.isdir(logs.plugin_log_dir(plugin or "")):
            return _error(404, f"no log dir {logs.plugin_log_dir(plugin or '')}")
        return await self._sse(request, logs.follow(source, plugin, n))

    async def _sse(self, request: web.Request, lines) -> web.StreamResponse:
        """Stream an async iterator of strings as `data:` events with keepalive comments."""
        res = web.StreamResponse(headers=SSE_HEADERS)
        await res.prepare(request)
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
                    if _closed(request):
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

    # ---- apps and game files ----

    @property
    def apps(self) -> Apps:
        if self._apps is None:
            self._apps = Apps()
        return self._apps

    async def handle_apps(self, request: web.Request) -> web.Response:
        installed = request.query.get("installed_only", "1") not in ("0", "false")
        tools = request.query.get("include_tools", "0") in ("1", "true")
        return await _json(lambda: self.apps.list(installed, request.query.get("query"), tools))

    async def handle_app_dirs(self, request: web.Request) -> web.Response:
        return await _json(lambda: self.apps.dirs(_appid(request)))

    async def handle_app_saves(self, request: web.Request) -> web.Response:
        return await _json(lambda: self.apps.saves(_appid(request), int(request.query.get("limit", 40))))

    async def handle_app_proton_log(self, request: web.Request) -> web.Response:
        return await _json(lambda: asyncio.to_thread(games.proton_log, _appid(request), int(request.query.get("lines", 200))))

    async def handle_app_launch(self, request: web.Request) -> web.Response:
        return await _json(lambda: _with_body(request, {"wait"}, lambda wait=15: self.apps.launch(_appid(request), wait)))

    async def handle_app_terminate(self, request: web.Request) -> web.Response:
        return await _json(lambda: _with_body(request, {"confirm", "wait"},
                                              lambda confirm=False, wait=15: self.apps.terminate(_appid(request), confirm, wait)))

    async def handle_fs(self, request: web.Request) -> web.Response:
        path = request.query.get("path")
        if not path:
            return _error(400, "path is required")
        try:
            depth = int(request.query.get("depth", 1))
        except ValueError:
            return _error(400, "depth must be an integer")
        glob = request.query.get("glob") or None
        return await self._fs_call(request, lambda: games.fs_list(path, depth, glob))

    async def _fs_call(self, request: web.Request, fn) -> web.Response:
        try:
            result = await asyncio.to_thread(fn)
        except PermissionError as e:
            return web.json_response({"error": str(e), "code": "EACCES"}, status=403)
        except FileExistsError as e:
            return web.json_response({"error": str(e), "code": "EEXIST"}, status=409)
        except IsADirectoryError as e:
            return web.json_response({"error": str(e), "code": "EISDIR"}, status=409)
        except NotADirectoryError as e:
            return web.json_response({"error": str(e), "code": "ENOTDIR"}, status=409)
        except FileNotFoundError as e:
            return web.json_response({"error": str(e), "code": "ENOENT"}, status=404)
        except games.TooLarge as e:
            return web.json_response({"error": str(e), "code": "EFBIG"}, status=413)
        except ValueError as e:
            return _error(400, str(e))
        except OSError as e:
            return _error(500, str(e))
        if isinstance(result, bytes):
            return web.Response(body=result, content_type="application/octet-stream")
        return web.json_response(result)

    @staticmethod
    def _flag(request: web.Request, name: str, default: bool) -> bool:
        raw = request.query.get(name)
        return default if raw is None else raw not in ("0", "false", "")

    async def handle_fs_read(self, request: web.Request) -> web.Response:
        path = request.query.get("path")
        if not path:
            return _error(400, "path is required")
        return await self._fs_call(request, lambda: games.fs_read(path))

    async def handle_fs_write(self, request: web.Request) -> web.Response:
        path = request.query.get("path")
        if not path:
            return _error(400, "path is required")
        data = await request.read()
        create, overwrite = self._flag(request, "create", True), self._flag(request, "overwrite", True)
        return await self._fs_call(request, lambda: games.fs_write(path, data, games.device_write_scope(), create=create,
                                                                   overwrite=overwrite))

    async def handle_fs_mkdir(self, request: web.Request) -> web.Response:
        try:
            body = await _body(request, {"path", "parents"})
        except ValueError as e:
            return _error(400, str(e))
        path = body.get("path")
        if not isinstance(path, str) or not path:
            return _error(400, "path is required")
        parents = body.get("parents") is True
        return await self._fs_call(request, lambda: games.fs_mkdir(path, games.device_write_scope(), parents=parents))

    async def handle_fs_rename(self, request: web.Request) -> web.Response:
        try:
            body = await _body(request, {"from", "to", "overwrite"})
        except ValueError as e:
            return _error(400, str(e))
        src, dst = body.get("from"), body.get("to")
        if not isinstance(src, str) or not src or not isinstance(dst, str) or not dst:
            return _error(400, "from and to are required")
        overwrite = body.get("overwrite") is True
        return await self._fs_call(request, lambda: games.fs_rename(src, dst, games.device_write_scope(), overwrite=overwrite))

    async def handle_fs_delete(self, request: web.Request) -> web.Response:
        path = request.query.get("path")
        if not path:
            return _error(400, "path is required")
        if request.query.get("confirm") != "1":
            return _error(400, "deleting is destructive: add confirm=1")
        return await self._fs_call(request, lambda: games.fs_delete(path, True, games.device_delete_roots()))

