"""MCP over Streamable HTTP (stateless): JSON-RPC dispatch for initialize, ping, tools/list, tools/call.

No sessions, no SSE: a POST always gets a plain application/json reply (allowed by every spec
revision from 2025-03-26 on), GET returns 405. Authentication is applied by the app middleware.
"""
import json
import logging
import os
import traceback
from pathlib import Path
from typing import Any, Awaitable, Callable

from aiohttp import web

from ..tools import ToolRegistry

SUPPORTED_PROTOCOL_VERSIONS = ("2025-11-25", "2025-06-18", "2025-03-26")


def _plugin_version() -> str:
    # release-please bumps package.json; the loader exports that version as DECKY_PLUGIN_VERSION.
    if v := os.environ.get("DECKY_PLUGIN_VERSION"):
        return v
    try:
        return json.loads((Path(__file__).resolve().parents[2] / "package.json").read_text())["version"]
    except (OSError, ValueError, KeyError):
        return "0.0.0"


SERVER_INFO = {"name": "decky-toolkit", "version": _plugin_version()}

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
    def __init__(self, tools: ToolRegistry, logger: logging.Logger):
        self.tools = tools
        self.log = logger
        tools.log = logger
        self._methods: dict[str, Handler] = {
            "initialize": self._initialize,
            "ping": self._ping,
            "tools/list": self._tools_list,
            "tools/call": self._tools_call,
        }

    def routes(self) -> list[web.RouteDef]:
        return [
            web.post("/mcp", self.handle_post),
            web.get("/mcp", self.handle_method_not_allowed),
            web.delete("/mcp", self.handle_delete),
        ]

    async def handle_method_not_allowed(self, _request: web.Request) -> web.Response:
        return web.Response(status=405, headers={"Allow": "POST, DELETE"})

    async def handle_delete(self, _request: web.Request) -> web.Response:
        # Stateless server: there is no session to terminate.
        return web.Response(status=200)

    async def handle_post(self, request: web.Request) -> web.Response:
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
        if not isinstance(method, str):
            # A response from the client (e.g. to a server request); we never send any, so ignore it.
            return None
        if "id" not in msg:
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
                "Decky Toolkit runs inside Decky Loader on a Steam Deck / Bazzite device. Tools are named "
                "<area>_<action>. Check device_activity before moving the UI under a person. ui_state says where the "
                "Steam UI is; logs_read and logs_wait cover the loader journal, plugin logs, the Steam UI console and "
                "Proton logs; plugin_reload reloads a plugin in place; device_run runs shell commands; cef_evaluate "
                "runs JS in the Steam UI; screen_capture shows the whole display."
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
