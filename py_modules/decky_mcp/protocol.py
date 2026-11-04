"""MCP Streamable HTTP transport (stateless) on aiohttp, plus the JSON-RPC method dispatch.

Only the server→client features we need are implemented: initialize, ping, tools/list, tools/call.
No sessions, no SSE: a POST always gets a plain application/json reply (allowed by every spec
revision from 2025-03-26 on), GET returns 405.
"""
import hmac
import json
import logging
import traceback
from typing import Any, Awaitable, Callable
from urllib.parse import urlparse

from aiohttp import web

from .tools import ToolRegistry

SUPPORTED_PROTOCOL_VERSIONS = ("2025-11-25", "2025-06-18", "2025-03-26")
SERVER_INFO = {"name": "decky-mcp", "version": "0.1.0"}

PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603

Handler = Callable[[dict[str, Any]], Awaitable[Any]]


def _rpc_error(msg_id: Any, code: int, message: str, data: Any = None) -> dict[str, Any]:
    err: dict[str, Any] = {"code": code, "message": message}
    if data is not None:
        err["data"] = data
    return {"jsonrpc": "2.0", "id": msg_id, "error": err}


class McpServer:
    def __init__(self, tools: ToolRegistry, token: str, logger: logging.Logger):
        self.tools = tools
        self.token = token
        self.log = logger
        self._methods: dict[str, Handler] = {
            "initialize": self._initialize,
            "ping": self._ping,
            "tools/list": self._tools_list,
            "tools/call": self._tools_call,
        }

    def build_app(self) -> web.Application:
        app = web.Application(client_max_size=16 * 1024 * 1024)
        app.add_routes([
            web.get("/health", self.handle_health),
            web.post("/mcp", self.handle_post),
            web.get("/mcp", self.handle_method_not_allowed),
            web.delete("/mcp", self.handle_delete),
        ])
        return app

    async def handle_health(self, _request: web.Request) -> web.Response:
        return web.json_response({"ok": True, **SERVER_INFO, "tools": len(self.tools)})

    async def handle_method_not_allowed(self, _request: web.Request) -> web.Response:
        return web.Response(status=405, headers={"Allow": "POST, DELETE"})

    async def handle_delete(self, request: web.Request) -> web.Response:
        denied = self._authorize(request)
        if denied:
            return denied
        # Stateless server: there is no session to terminate.
        return web.Response(status=200)

    def _authorize(self, request: web.Request) -> web.Response | None:
        origin = request.headers.get("Origin")
        if origin and not self._origin_allowed(origin, request.host):
            return web.Response(status=403, text="Origin not allowed")
        auth = request.headers.get("Authorization", "")
        scheme, _, presented = auth.partition(" ")
        if scheme.lower() != "bearer" or not hmac.compare_digest(presented.strip(), self.token):
            return web.Response(status=401, text="Unauthorized", headers={"WWW-Authenticate": 'Bearer realm="decky-mcp"'})
        return None

    @staticmethod
    def _origin_allowed(origin: str, request_host: str) -> bool:
        # Browsers send Origin; CLI MCP clients normally don't. Guard against DNS-rebinding
        # style attacks by only accepting origins that point back at this host or loopback.
        host = urlparse(origin).hostname or ""
        return host in ("localhost", "127.0.0.1", "::1") or host == request_host.split(":")[0]

    async def handle_post(self, request: web.Request) -> web.Response:
        denied = self._authorize(request)
        if denied:
            return denied
        version = request.headers.get("MCP-Protocol-Version")
        if version and version not in SUPPORTED_PROTOCOL_VERSIONS:
            return web.json_response(_rpc_error(None, INVALID_REQUEST, f"Unsupported MCP-Protocol-Version {version}"), status=400)
        try:
            payload = await request.json()
        except (json.JSONDecodeError, UnicodeDecodeError) as e:
            return web.json_response(_rpc_error(None, PARSE_ERROR, f"Parse error: {e}"), status=400)

        if isinstance(payload, list):  # JSON-RPC batch, legal in 2025-03-26
            replies = [r for r in [await self._dispatch(m) for m in payload] if r is not None]
            return web.json_response(replies) if replies else web.Response(status=202)
        reply = await self._dispatch(payload)
        if reply is None:
            return web.Response(status=202)
        return web.json_response(reply)

    async def _dispatch(self, msg: Any) -> dict[str, Any] | None:
        if not isinstance(msg, dict) or msg.get("jsonrpc") != "2.0":
            return _rpc_error(None, INVALID_REQUEST, "Invalid JSON-RPC 2.0 message")
        method = msg.get("method")
        msg_id = msg.get("id")
        is_notification = "id" not in msg
        if not isinstance(method, str):
            # A response from the client (e.g. to a server request); we never send any, so ignore it.
            return None
        if is_notification:
            self.log.debug("notification %s", method)
            return None
        handler = self._methods.get(method)
        if handler is None:
            return _rpc_error(msg_id, METHOD_NOT_FOUND, f"Method not found: {method}")
        try:
            result = await handler(msg.get("params") or {})
        except ValueError as e:
            return _rpc_error(msg_id, INVALID_PARAMS, str(e))
        except Exception as e:  # noqa: BLE001 - must always answer the RPC
            self.log.error("%s failed: %s", method, traceback.format_exc())
            return _rpc_error(msg_id, INTERNAL_ERROR, f"{type(e).__name__}: {e}")
        return {"jsonrpc": "2.0", "id": msg_id, "result": result}

    async def _initialize(self, params: dict[str, Any]) -> dict[str, Any]:
        requested = params.get("protocolVersion")
        version = requested if requested in SUPPORTED_PROTOCOL_VERSIONS else SUPPORTED_PROTOCOL_VERSIONS[0]
        return {
            "protocolVersion": version,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": SERVER_INFO,
            "instructions": (
                "Decky-MCP runs inside Decky Loader on a Steam Deck / Bazzite device. "
                "Use cef_evaluate to run JS in the Steam UI (SharedJSContext), the log tools to debug "
                "plugin backends, and restart_loader after deploying a plugin."
            ),
        }

    async def _ping(self, _params: dict[str, Any]) -> dict[str, Any]:
        return {}

    async def _tools_list(self, _params: dict[str, Any]) -> dict[str, Any]:
        return {"tools": self.tools.describe()}

    async def _tools_call(self, params: dict[str, Any]) -> dict[str, Any]:
        name = params.get("name")
        if not isinstance(name, str):
            raise ValueError("tools/call requires a string 'name'")
        arguments = params.get("arguments") or {}
        if not isinstance(arguments, dict):
            raise ValueError("'arguments' must be an object")
        return await self.tools.call(name, arguments)
