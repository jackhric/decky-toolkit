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
from .. import errors
from ..steam import cdp
from ..games import files as games
from ..loader import live, logs, plugins
from ..loader.plugins import list_plugins, schedule_loader_restart
from .identity import identity
from ..media.audio import FORMAT as AUDIO_FORMAT, AudioDisabled, AudioUnavailable
from .auth import CertAuth
from ..media.capture import BOUNDARY, CaptureUnavailable
from ..input.ei import EiError
from ..input.service import InputDisabled, InputUnavailable
from .events import frame
from .long_lived import LongLivedRequests
from .pairing import MAX_WAIT_SECONDS, POLL_AFTER_MS
from .protocol import SERVER_INFO, McpServer
from ..services import Services
from ..steam.toast import toast

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


@web.middleware
async def _errors(request: web.Request, handler):
    try:
        return await handler(request)
    except errors.HANDLED as e:
        return web.json_response(errors.body(e), status=errors.status_of(e)[0])


async def _object(request: web.Request) -> dict:
    """The JSON object body (empty when there is none)."""
    if not request.can_read_body:
        return {}
    try:
        body = await request.json()
    except (ValueError, UnicodeDecodeError):
        raise ValueError("expected a JSON object") from None
    if not isinstance(body, dict):
        raise ValueError("expected a JSON object")
    return body


async def _body(request: web.Request, allowed: set[str], required: tuple[str, ...] = ()) -> dict:
    body = await _object(request)
    if unknown := set(body) - allowed:
        raise ValueError(f"unknown field(s): {', '.join(sorted(unknown))}")
    if missing := [k for k in required if k not in body]:
        raise ValueError(f"missing field(s): {', '.join(missing)}")
    return body


def _query(request: web.Request, name: str) -> str:
    if not (value := request.query.get(name)):
        raise ValueError(f"{name} is required")
    return value


def _flag(request: web.Request, name: str, default: bool) -> bool:
    raw = request.query.get(name)
    return default if raw is None else raw not in ("0", "false", "")


def _appid(request: web.Request) -> int:
    raw = request.match_info["appid"]
    if not raw.isdigit() or int(raw) <= 0:
        raise ValueError("appid must be a positive integer")
    return int(raw)


class Api:
    def __init__(self, services: Services, *, auth: CertAuth, mcp: McpServer, logger: logging.Logger,
                 log_keepalive: float = LOG_KEEPALIVE_SECONDS, heartbeat: float = HEARTBEAT_SECONDS):
        self.s = services
        self.auth = auth
        self.mcp = mcp
        self.log = logger
        self.log_keepalive = log_keepalive
        self.heartbeat = heartbeat
        self.long_lived = LongLivedRequests()

    def build_app(self) -> web.Application:
        app = web.Application(client_max_size=64 * 1024 * 1024,
                              middlewares=[_not_found, self.auth.middleware(), audit.middleware(self.log), _errors])
        # Before long_lived drops the transports, so event streams get to write `shutdown`.
        app.on_shutdown.append(lambda _app: self.s.events.close())
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
            web.get("/ui/tweaks", self.handle_ui_tweaks_get),
            web.put("/ui/tweaks", self.handle_ui_tweaks_put),
            web.post("/cef/evaluate", self.handle_cef_evaluate),
            web.get("/plugins", self.handle_plugins),
            web.post("/plugins/install", self.handle_plugin_install),
            web.post("/plugins/reload", self.handle_plugin_reload),
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
        body = await _object(request)
        req = self.s.pairing.create(body.get("client_name"), body.get("client_kind", "other"), body.get("public_key"),
                                    request.remote or "?")
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
            raise ValueError("wait must be a number of seconds") from None
        pairing = self.s.pairing
        req = pairing.touch(request_id)
        if req is not None and wait:
            await pairing.wait(req, wait)
        req = pairing.touch(request_id)
        if req is None:
            return _error(404, "unknown or expired pairing request")
        no_store = {"Cache-Control": "no-store"}
        if pairing.claim_credentials(req):
            self.log.info("pairing: delivered credentials to %s (%s)", req.remote, req.client_name)
            return web.json_response({"status": "approved", "client_cert": req.client_cert,
                                      "server_cert": pairing.server_cert},
                                     headers=no_store)
        return web.json_response({"status": req.status}, headers=no_store)

    async def handle_pair_cancel(self, request: web.Request) -> web.Response:
        if denied := self._foreign_origin(request):
            return denied
        if not self.s.pairing.cancel(request.match_info["id"]):
            return _error(404, "no pending pairing request with that id")
        return web.json_response({"cancelled": True})

    # ---- stream ----

    async def handle_stream(self, request: web.Request) -> web.StreamResponse:
        res = web.StreamResponse(headers={
            "Content-Type": f"multipart/x-mixed-replace; boundary={BOUNDARY.decode()}",
            "Cache-Control": "no-store",
            "X-Accel-Buffering": "no",
        })
        await res.prepare(request)
        try:
            with self.auth.connections.watching_screen():
                async for frame in self.s.capturer.subscribe(tick=True):
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
        frame = await self.s.capturer.grab()
        return web.Response(body=frame, content_type="image/jpeg", headers={"Cache-Control": "no-store"})

    async def handle_stream_stats(self, _request: web.Request) -> web.Response:
        return web.json_response(self.s.capturer.stats())

    async def handle_stream_settings_get(self, _request: web.Request) -> web.Response:
        return web.json_response(self.s.capturer.stream_settings())

    async def handle_stream_settings_put(self, request: web.Request) -> web.Response:
        body = await _body(request, {"fps", "quality", "width", "audio"})
        return web.json_response(await self.s.capturer.update_settings(**body))

    # ---- audio ----

    async def handle_audio_ws(self, request: web.Request) -> web.StreamResponse:
        audio = self.s.audio
        ws = web.WebSocketResponse(heartbeat=20, max_msg_size=4096)
        await ws.prepare(request)
        if not audio.enabled:
            await ws.close(code=AUDIO_REFUSED, message=b"audio is disabled")
            return ws
        await ws.send_json(AUDIO_FORMAT)

        async def pump() -> None:
            try:
                async for chunk in audio.subscribe():
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
        return web.json_response(self.s.input.status())

    async def handle_input_settings_put(self, request: web.Request) -> web.Response:
        body = await _body(request, {"enabled"}, ("enabled",))
        return web.json_response(await self.s.input.set_enabled(body["enabled"]))

    async def handle_input_ws(self, request: web.Request) -> web.StreamResponse:
        svc = self.s.input
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
        return web.json_response(await self.s.controllers.snapshot())

    async def handle_controller_add(self, request: web.Request) -> web.Response:
        body = await _body(request, {"name"})
        return web.json_response(await self.s.controllers.add_virtual(body.get("name")), status=201)

    async def handle_controller_remove(self, request: web.Request) -> web.Response:
        pad_id = request.match_info["id"]
        if not self.s.controllers.remove_virtual(pad_id):
            return _error(404, f"no virtual gamepad {pad_id!r}")
        return web.json_response({"removed": pad_id})

    # ---- events ----

    async def handle_events(self, request: web.Request) -> web.StreamResponse:
        res = web.StreamResponse(headers=SSE_HEADERS)
        await res.prepare(request)
        loop = asyncio.get_running_loop()
        events = self.s.events
        with events.subscribe() as sub:
            try:
                await res.write(frame("hello", {"version": SERVER_INFO["version"], "api": list(API_VERSIONS),
                                                "state": await events.snapshot()}))
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
        return web.json_response(await self.s.ui.routes())

    async def handle_ui_navigate(self, request: web.Request) -> web.Response:
        body = await _body(request, {"path", "action", "tab", "plugin", "appid"})
        return web.json_response(await self.s.ui.navigate(**body))

    async def handle_ui_toast(self, request: web.Request) -> web.Response:
        body = await _body(request, {"title", "body", "duration_ms"}, ("title", "body"))
        return web.json_response({"result": await toast(body["title"], body["body"], body.get("duration_ms", 5000))})

    async def handle_ui_tweaks_get(self, _request: web.Request) -> web.Response:
        return web.json_response(self.s.tweaks.settings())

    async def handle_ui_tweaks_put(self, request: web.Request) -> web.Response:
        body = await _body(request, {"off"}, ("off",))
        return web.json_response(self.s.tweaks.set_off(body["off"]))

    async def handle_cef_evaluate(self, request: web.Request) -> web.Response:
        body = await _body(request, {"expression", "target", "timeout"}, ("expression",))
        return web.json_response({"value": await cdp.evaluate_in(body.get("target"), body["expression"],
                                                                 timeout=body.get("timeout", 15))})

    # ---- plugins ----

    async def handle_plugins(self, _request: web.Request) -> web.Response:
        return web.json_response(await list_plugins())

    async def handle_plugin_reload(self, request: web.Request) -> web.Response:
        body = await _body(request, {"plugin", "mode"}, ("plugin",))
        return web.json_response(await live.reload(body.get("plugin"), body.get("mode", "backend")))

    async def handle_loader_restart(self, _request: web.Request) -> web.Response:
        await schedule_loader_restart()
        return web.json_response({"restarting": True, "delay_s": 1})

    async def handle_plugin_install(self, request: web.Request) -> web.Response:
        restart = request.query.get("restart", "loader")
        if restart not in plugins.RESTART_MODES:
            raise ValueError(f"restart must be one of {', '.join(plugins.RESTART_MODES)}")
        if not request.content_type.startswith("multipart/"):
            raise ValueError("expected multipart/form-data with a 'file' field")
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
                raise ValueError("missing multipart field 'file'")
            tmp.flush()
            return web.json_response(await plugins.install(tmp.name, restart, self.s.events, self.log))

    async def handle_plugin_file_put(self, request: web.Request) -> web.Response:
        rel = request.query.get("path", "")
        data = await request.read()
        return web.json_response(await asyncio.to_thread(live.write_file, request.match_info["dir"], rel, data))

    # ---- logs ----

    @staticmethod
    def _log_query(request: web.Request) -> tuple[str, str | None, int]:
        plugin = request.query.get("plugin") or None
        source = request.query.get("source") or ("plugin" if plugin else "loader")
        if source not in logs.SOURCES:
            raise ValueError(f"source must be one of {', '.join(logs.SOURCES)}")
        if source == "plugin":
            # plugin is the plugin.json name; Decky names the log dir after the install dir.
            plugin = plugins.plugin_dir(plugin or "")
        try:
            n = int(request.query.get("tail", logs.DEFAULT_TAIL))
        except ValueError:
            raise ValueError("tail must be an integer") from None
        return source, plugin, max(0, min(n, logs.MAX_TAIL))

    async def handle_logs_tail(self, request: web.Request) -> web.Response:
        source, plugin, n = self._log_query(request)
        return web.json_response({"lines": await logs.tail_lines(source, plugin, n)})

    async def handle_logs_stream(self, request: web.Request) -> web.StreamResponse:
        source, plugin, n = self._log_query(request)
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

    async def handle_apps(self, request: web.Request) -> web.Response:
        installed = request.query.get("installed_only", "1") not in ("0", "false")
        tools = request.query.get("include_tools", "0") in ("1", "true")
        return web.json_response(await self.s.apps.list(installed, request.query.get("query"), tools))

    async def handle_app_dirs(self, request: web.Request) -> web.Response:
        return web.json_response(await self.s.apps.dirs(_appid(request)))

    async def handle_app_saves(self, request: web.Request) -> web.Response:
        return web.json_response(await self.s.apps.saves(_appid(request), int(request.query.get("limit", 40))))

    async def handle_app_proton_log(self, request: web.Request) -> web.Response:
        appid, lines = _appid(request), int(request.query.get("lines", 200))
        return web.json_response(await asyncio.to_thread(games.proton_log, appid, lines))

    async def handle_app_launch(self, request: web.Request) -> web.Response:
        body = await _body(request, {"wait"})
        return web.json_response(await self.s.apps.launch(_appid(request), body.get("wait", 15)))

    async def handle_app_terminate(self, request: web.Request) -> web.Response:
        body = await _body(request, {"confirm", "wait"})
        return web.json_response(await self.s.apps.terminate(_appid(request), body.get("confirm", False),
                                                             body.get("wait", 15)))

    async def handle_fs(self, request: web.Request) -> web.Response:
        path = _query(request, "path")
        try:
            depth = int(request.query.get("depth", 1))
        except ValueError:
            raise ValueError("depth must be an integer") from None
        glob = request.query.get("glob") or None
        return web.json_response(await asyncio.to_thread(games.fs_list, path, depth, glob))

    async def handle_fs_read(self, request: web.Request) -> web.Response:
        data, _ = await asyncio.to_thread(games.fs_read, _query(request, "path"))
        return web.Response(body=data, content_type="application/octet-stream")

    async def handle_fs_write(self, request: web.Request) -> web.Response:
        path = _query(request, "path")
        data = await request.read()
        create, overwrite = _flag(request, "create", True), _flag(request, "overwrite", True)
        raw_mode = request.query.get("mode")
        mode = None if raw_mode is None else games.parse_mode(raw_mode)
        return web.json_response(await asyncio.to_thread(
            lambda: games.fs_write(path, data, games.device_write_scope(), create=create, overwrite=overwrite, mode=mode)))

    async def handle_fs_mkdir(self, request: web.Request) -> web.Response:
        body = await _body(request, {"path", "parents"})
        path = body.get("path")
        if not isinstance(path, str) or not path:
            raise ValueError("path is required")
        parents = body.get("parents") is True
        return web.json_response(await asyncio.to_thread(
            lambda: games.fs_mkdir(path, games.device_write_scope(), parents=parents)))

    async def handle_fs_rename(self, request: web.Request) -> web.Response:
        body = await _body(request, {"from", "to", "overwrite"})
        src, dst = body.get("from"), body.get("to")
        if not isinstance(src, str) or not src or not isinstance(dst, str) or not dst:
            raise ValueError("from and to are required")
        overwrite = body.get("overwrite") is True
        return web.json_response(await asyncio.to_thread(
            lambda: games.fs_rename(src, dst, games.device_write_scope(), overwrite=overwrite)))

    async def handle_fs_delete(self, request: web.Request) -> web.Response:
        path = _query(request, "path")
        if request.query.get("confirm") != "1":
            raise ValueError("deleting is destructive: add confirm=1")
        return web.json_response(await asyncio.to_thread(games.fs_delete, path, True, games.device_delete_roots()))
