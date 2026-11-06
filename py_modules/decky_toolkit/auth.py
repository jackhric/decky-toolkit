"""Client-certificate authentication shared by the MCP and REST routes."""
import asyncio
from typing import Callable
from urllib.parse import urlparse

from aiohttp import web

from . import audit
from .tls import PairedClients, fingerprint_der

# Public routes. The removed timed-window `/pair` and the browser `/viewer` stay listed so old clients
# get a plain 404 instead of a 401.
SELF_AUTH_PATHS = frozenset({"/", "/health", "/viewer", "/pair", "/pair/request"})
PAIR_REQUEST_PREFIX = "/pair/request/"


def peer_fingerprint(request: web.Request) -> str | None:
    ssl_object = request.transport.get_extra_info("ssl_object") if request.transport else None
    der = ssl_object.getpeercert(binary_form=True) if ssl_object else None
    return fingerprint_der(der) if der else None


class Connections:
    """Transports of in-flight requests per client fingerprint, so forgetting a client also ends its open
    streams (MJPEG, SSE, WebSocket) instead of letting them run until the client hangs up."""

    def __init__(self):
        self._live: dict[str, dict[asyncio.BaseTransport, int]] = {}

    def add(self, fp: str, transport: asyncio.BaseTransport) -> None:
        live = self._live.setdefault(fp, {})
        live[transport] = live.get(transport, 0) + 1

    def remove(self, fp: str, transport: asyncio.BaseTransport) -> None:
        live = self._live.get(fp, {})
        if live.get(transport, 0) > 1:
            live[transport] -= 1
        else:
            live.pop(transport, None)
        if not live:
            self._live.pop(fp, None)

    def count(self, fp: str) -> int:
        return len(self._live.get(fp, {}))

    def close(self, fp: str) -> int:
        live = self._live.pop(fp, {})
        for transport in live:
            transport.close()
        return len(live)


class CertAuth:
    def __init__(self, clients: PairedClients, peer: Callable[[web.Request], str | None] = peer_fingerprint,
                 connections: Connections | None = None):
        self.clients = clients
        self.peer = peer
        self.connections = connections if connections is not None else Connections()

    @staticmethod
    def origin_allowed(origin: str, request_host: str) -> bool:
        # Browsers send Origin; CLI MCP clients normally don't. Guard against DNS-rebinding style
        # attacks by only accepting origins that point back at this host or loopback.
        host = urlparse(origin).hostname or ""
        return host in ("localhost", "127.0.0.1", "::1") or host == request_host.split(":")[0]

    def check(self, request: web.Request) -> web.Response | dict:
        """The paired client making the request, or the response refusing it."""
        origin = request.headers.get("Origin")
        if origin and not self.origin_allowed(origin, request.host):
            return web.Response(status=403, text="Origin not allowed")
        fp = self.peer(request)
        client = self.clients.touch(fp, request.remote) if fp else None
        return client if client is not None else web.Response(status=401, text="Unauthorized")

    def middleware(self):
        @web.middleware
        async def auth_middleware(request: web.Request, handler):
            if request.path in SELF_AUTH_PATHS or request.path.startswith(PAIR_REQUEST_PREFIX):
                return await handler(request)
            client = self.check(request)
            if isinstance(client, web.StreamResponse):
                return client
            fp, transport = client["fingerprint"], request.transport
            if transport is not None:
                self.connections.add(fp, transport)
            token = audit.paired_client.set(client["name"])
            try:
                return await handler(request)
            finally:
                audit.paired_client.reset(token)
                if transport is not None:
                    self.connections.remove(fp, transport)
        return auth_middleware
