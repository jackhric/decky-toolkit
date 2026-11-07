"""The site's HTTP routes page lists exactly the routes the server registers, with the right auth. Run with: ./scripts/test.sh"""
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "py_modules"))

from certauth import stub_auth  # noqa: E402
from decky_toolkit.server.auth import PAIR_REQUEST_PREFIX, SELF_AUTH_PATHS  # noqa: E402
from decky_toolkit.server.http import Api  # noqa: E402
from decky_toolkit.server.protocol import McpServer  # noqa: E402
from decky_toolkit.tools import ToolRegistry  # noqa: E402
from harness import LOG, make_services  # noqa: E402

PAGE = Path(__file__).resolve().parents[1] / "site/src/content/docs/docs/reference/routes.md"
ROW = re.compile(r"^\| (GET|POST|PUT|DELETE) \| `([^`]+)` \| [^|]+ \| (none|paired client) \|$")


def registered() -> dict[tuple[str, str], str]:
    app = Api(make_services(), auth=stub_auth(), mcp=McpServer(ToolRegistry(), LOG), logger=LOG).build_app()
    out = {}
    for route in app.router.routes():
        if route.method == "HEAD":  # aiohttp adds one per GET
            continue
        path = route.resource.canonical
        public = path in SELF_AUTH_PATHS or path.startswith(PAIR_REQUEST_PREFIX)
        out[(route.method, path)] = "none" if public else "paired client"
    return out


def documented() -> dict[tuple[str, str], str]:
    rows = [ROW.match(line) for line in PAGE.read_text().splitlines() if line.startswith("| ") and "`/" in line]
    assert all(rows), "every route row is | METHOD | `path` | purpose | none or paired client |"
    return {(m[1], m[2]): m[3] for m in rows}


def test_routes_page_matches_the_server():
    real, page = registered(), documented()
    assert sorted(real.keys() - page.keys()) == [], "registered but missing from the routes page"
    assert sorted(page.keys() - real.keys()) == [], "on the routes page but not registered"
    assert {k: v for k, v in page.items() if real[k] != v} == {}, "wrong auth on the routes page"
