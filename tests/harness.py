"""The one way tests build the services and serve the HTTP app: real services with inert defaults, any of them
replaceable by a fake."""
import dataclasses
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "py_modules"))

from aiohttp import ClientSession, ClientTimeout, CookieJar, web  # noqa: E402

from certauth import stub_auth  # noqa: E402
from decky_toolkit.server.events import EventHub  # noqa: E402
from decky_toolkit.server.http import HEARTBEAT_SECONDS, LOG_KEEPALIVE_SECONDS, Api  # noqa: E402
from decky_toolkit.server.protocol import McpServer  # noqa: E402
from decky_toolkit.services import Services  # noqa: E402
from decky_toolkit.settings import Settings  # noqa: E402
from decky_toolkit.tools import ToolRegistry, build_registry  # noqa: E402

LOG = logging.getLogger("t")


async def _no_steam():
    return None


def make_services(**overrides) -> Services:
    settings = Settings()
    events = overrides.get("events", EventHub(logger=LOG))
    s = Services.create(lambda: settings, lambda: None, LOG, events, "")
    # Not reading /proc or Steam, and not watching for subscribers, unless a test brings its own ControllerService.
    s.controllers._read_devices, s.controllers._steam_query = lambda: "", _no_steam
    events.on_subscribe.remove(s.controllers._watch)
    return dataclasses.replace(s, **overrides)


def make_registry(**overrides) -> ToolRegistry:
    return build_registry(make_services(**overrides))


async def with_server(fn, *, services: Services | None = None, mcp: ToolRegistry | None = None, auth=None,
                      ssl_context=None, logger=LOG, log_keepalive: float = LOG_KEEPALIVE_SECONDS,
                      heartbeat: float = HEARTBEAT_SECONDS, **overrides):
    """Run the app on a free port and call `fn(session, base_url)`; `services`, or keyword arguments that replace
    single services."""
    api = Api(services or make_services(**overrides), auth=auth or stub_auth(), mcp=McpServer(mcp or ToolRegistry(), logger),
              logger=logger, log_keepalive=log_keepalive, heartbeat=heartbeat)
    runner = web.AppRunner(api.build_app(), shutdown_timeout=2)
    await runner.setup()
    await web.TCPSite(runner, "127.0.0.1", 0, ssl_context=ssl_context).start()
    base = f"{'https' if ssl_context else 'http'}://127.0.0.1:{runner.addresses[0][1]}"
    try:
        async with ClientSession(timeout=ClientTimeout(total=10), cookie_jar=CookieJar(unsafe=True)) as s:
            await fn(s, base)
    finally:
        await runner.cleanup()
