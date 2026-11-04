"""Bearer-token / cookie authentication shared by the MCP and REST routes."""
import hmac
from urllib.parse import urlparse

from aiohttp import web

TOKEN_COOKIE = "decky_mcp_token"
COOKIE_MAX_AGE = 30 * 86400
# Routes that are public or do their own token handling (viewer accepts ?token= and pairing).
SELF_AUTH_PATHS = frozenset({"/", "/health", "/viewer", "/pair"})


class TokenAuth:
    def __init__(self, token: str):
        self.token = token

    def has_bearer(self, request: web.Request) -> bool:
        scheme, _, presented = request.headers.get("Authorization", "").partition(" ")
        return scheme.lower() == "bearer" and hmac.compare_digest(presented.strip(), self.token)

    def has_cookie(self, request: web.Request) -> bool:
        cookie = request.cookies.get(TOKEN_COOKIE, "")
        return bool(cookie) and hmac.compare_digest(cookie, self.token)

    def token_matches(self, presented: str) -> bool:
        return hmac.compare_digest(presented, self.token)

    @staticmethod
    def origin_allowed(origin: str, request_host: str) -> bool:
        # Browsers send Origin; CLI MCP clients normally don't. Guard against DNS-rebinding style
        # attacks by only accepting origins that point back at this host or loopback.
        host = urlparse(origin).hostname or ""
        return host in ("localhost", "127.0.0.1", "::1") or host == request_host.split(":")[0]

    def check(self, request: web.Request) -> web.Response | None:
        origin = request.headers.get("Origin")
        if origin and not self.origin_allowed(origin, request.host):
            return web.Response(status=403, text="Origin not allowed")
        if self.has_bearer(request) or self.has_cookie(request):
            return None
        return web.Response(status=401, text="Unauthorized", headers={"WWW-Authenticate": 'Bearer realm="decky-mcp"'})

    def grant_cookie(self, response: web.StreamResponse) -> None:
        response.set_cookie(TOKEN_COOKIE, self.token, httponly=True, samesite="Strict", path="/", max_age=COOKIE_MAX_AGE)

    def middleware(self):
        @web.middleware
        async def auth_middleware(request: web.Request, handler):
            if request.path not in SELF_AUTH_PATHS:
                denied = self.check(request)
                if denied:
                    return denied
            return await handler(request)
        return auth_middleware
