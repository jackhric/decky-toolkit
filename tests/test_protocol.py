"""Protocol + auth tests. Run with: ./scripts/test.sh (uses uv to supply aiohttp and pytest)."""
import asyncio
import json
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "py_modules"))

from aiohttp import ClientSession, CookieJar, web  # noqa: E402

from decky_mcp.auth import TokenAuth  # noqa: E402
from decky_mcp.http import Api  # noqa: E402
from decky_mcp.protocol import McpServer  # noqa: E402
from decky_mcp.tools import ToolRegistry  # noqa: E402

TOKEN = "test-token"
H = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}


def make_registry() -> ToolRegistry:
    reg = ToolRegistry()

    @reg.add("echo", "Echo text", {"properties": {"text": {"type": "string"}}, "required": ["text"]})
    async def echo(text: str) -> str:
        return text

    @reg.add("boom", "Raise")
    async def boom() -> None:
        raise ValueError("bad input")

    return reg


async def with_server(fn):
    api = Api(auth=TokenAuth(TOKEN), mcp=McpServer(make_registry(), logging.getLogger("t")), capturer=None,
              static_dir=None, logger=logging.getLogger("t"))
    runner = web.AppRunner(api.build_app())
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = runner.addresses[0][1]
    base = f"http://127.0.0.1:{port}"
    try:
        async with ClientSession(cookie_jar=CookieJar(unsafe=True)) as s:
            await fn(s, base)
    finally:
        await runner.cleanup()



def rpc(method, params=None, msg_id=1):
    body = {"jsonrpc": "2.0", "method": method}
    if msg_id is not None:
        body["id"] = msg_id
    if params is not None:
        body["params"] = params
    return json.dumps(body)


def test_auth_and_origin():
    async def run(s, base):
        async with s.post(f"{base}/mcp", data=rpc("ping")) as r:
            assert r.status == 401
        async with s.post(f"{base}/mcp", data=rpc("ping"), headers={**H, "Origin": "http://evil.example"}) as r:
            assert r.status == 403
        async with s.post(f"{base}/mcp", data=rpc("ping"), headers={**H, "Origin": "http://localhost:1234"}) as r:
            assert r.status == 200
        async with s.get(f"{base}/health") as r:
            assert r.status == 200 and (await r.json())["ok"]
        async with s.get(f"{base}/mcp", headers=H) as r:
            assert r.status == 405
    asyncio.run(with_server(run))


def test_mcp_flow():
    async def run(s, base):
        async with s.post(f"{base}/mcp", data=rpc("initialize", {"protocolVersion": "2025-06-18"}), headers=H) as r:
            body = await r.json()
            assert body["result"]["protocolVersion"] == "2025-06-18"
            assert body["result"]["capabilities"]["tools"] == {"listChanged": False}
        async with s.post(f"{base}/mcp", data=rpc("notifications/initialized", msg_id=None), headers=H) as r:
            assert r.status == 202
        async with s.post(f"{base}/mcp", data=rpc("tools/list"), headers=H) as r:
            names = [t["name"] for t in (await r.json())["result"]["tools"]]
            assert names == ["echo", "boom"]
        async with s.post(f"{base}/mcp", data=rpc("tools/call", {"name": "echo", "arguments": {"text": "hi"}}), headers=H) as r:
            res = (await r.json())["result"]
            assert res == {"content": [{"type": "text", "text": "hi"}], "isError": False}
        async with s.post(f"{base}/mcp", data=rpc("tools/call", {"name": "boom", "arguments": {}}), headers=H) as r:
            res = (await r.json())["result"]
            assert res["isError"] and "bad input" in res["content"][0]["text"] and "Traceback" not in res["content"][0]["text"]
        async with s.post(f"{base}/mcp", data=rpc("tools/call", {"name": "echo", "arguments": {"nope": 1}}), headers=H) as r:
            assert (await r.json())["result"]["isError"]
        async with s.post(f"{base}/mcp", data=rpc("nope"), headers=H) as r:
            assert (await r.json())["error"]["code"] == -32601
        async with s.post(f"{base}/mcp", data="{not json", headers=H) as r:
            assert r.status == 400
        async with s.post(f"{base}/mcp", data=rpc("ping"), headers={**H, "MCP-Protocol-Version": "1999-01-01"}) as r:
            assert r.status == 400
    asyncio.run(with_server(run))


def test_viewer_token_and_cookie():
    async def run(s, base):
        async with s.get(f"{base}/viewer") as r:
            assert r.status == 401
        async with s.get(f"{base}/viewer?token=wrong", allow_redirects=False) as r:
            assert r.status == 401
        async with s.get(f"{base}/viewer?token={TOKEN}", allow_redirects=False) as r:
            assert r.status == 302 and "decky_mcp_token" in r.headers.get("Set-Cookie", "")
        # cookie now authorises token-protected routes too
        async with s.get(f"{base}/stream/stats") as r:
            assert r.status == 200
        s.cookie_jar.clear()
        async with s.get(f"{base}/viewer") as r:
            assert r.status == 401
    asyncio.run(with_server(run))
