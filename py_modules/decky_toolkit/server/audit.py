"""Who called what: the request origin of the current HTTP request and the audit log line format."""
import contextvars
import json
import logging
from typing import Any, Iterable

from aiohttp import web

from . import PAIR_REQUEST_PATH

# (remote ip, client kind: "mcp" for /mcp, "http" for the REST routes, "local" outside a request,
# paired client name or "-")
request_origin: contextvars.ContextVar[tuple[str, str, str]] = contextvars.ContextVar(
    "request_origin", default=("-", "local", "-"))
# Set by the auth middleware, which runs outside this one.
paired_client: contextvars.ContextVar[str] = contextvars.ContextVar("paired_client", default="-")

AUDITED_TOOLS = frozenset({
    "cef_evaluate", "fs_write", "plugin_install", "plugin_reload", "loader_restart", "plugin_call",
    "input_settings", "controller_remove", "ui_navigate",
})
AUDITED_PREFIXES = ("input_",)
_UNAUDITED_ROUTES = ("/mcp", PAIR_REQUEST_PATH)


def is_audited(tool: str, audited: Iterable[str] = AUDITED_TOOLS) -> bool:
    return tool in audited or tool.startswith(AUDITED_PREFIXES)


def tool_line(tool: str, arguments: dict[str, Any], known: Iterable[str]) -> str:
    # Argument values can hold code, file contents or secrets: log names only, and only names the tool's
    # schema declares, since a client chooses the keys too.
    known = set(known)
    keys = sorted(k for k in arguments if k in known)
    unknown = len(arguments) - len(keys)
    ip, kind, client = request_origin.get()
    arg_text = ",".join(keys) or "-"
    if unknown:
        arg_text += f"+{unknown} unknown"
    return f"audit tool={tool} origin={ip} client={_quoted(client)} via={kind} args={arg_text}"


def _quoted(name: str) -> str:
    # Client names are user-chosen and may hold spaces or quotes.
    return json.dumps(name, ensure_ascii=False)


def middleware(logger: logging.Logger):
    @web.middleware
    async def audit_middleware(request: web.Request, handler):
        kind = "mcp" if request.path == "/mcp" else "http"
        client = paired_client.get()
        token = request_origin.set((request.remote or "?", kind, client))
        try:
            if request.method in ("POST", "PUT", "DELETE") and not request.path.startswith(_UNAUDITED_ROUTES):
                logger.info("audit route=%s %s origin=%s client=%s via=http", request.method, request.path,
                            request.remote, _quoted(client))
            return await handler(request)
        finally:
            request_origin.reset(token)
    return audit_middleware
