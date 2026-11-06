"""Protocol + auth tests. Run with: ./scripts/test.sh (uses uv to supply aiohttp and pytest)."""
import asyncio
import json
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "py_modules"))

from aiohttp import ClientSession, CookieJar, web  # noqa: E402

from certauth import H as PEER, stub_auth  # noqa: E402
from decky_toolkit.http import Api  # noqa: E402
from decky_toolkit.protocol import McpServer  # noqa: E402
from decky_toolkit.tools import ToolRegistry  # noqa: E402

H = {**PEER, "Content-Type": "application/json"}


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
    api = Api(auth=stub_auth(), mcp=McpServer(make_registry(), logging.getLogger("t")), capturer=None,
              logger=logging.getLogger("t"))
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
            body = await r.json()
            assert r.status == 200 and body["ok"]
            assert {"hostname", "device_id", "os"} <= body.keys() and body["hostname"]
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




def test_identity_hides_machine_id(tmp_path):
    from decky_toolkit.identity import device_id, os_name
    mid = tmp_path / "machine-id"
    mid.write_text("0123456789abcdef0123456789abcdef\n")
    did = device_id(mid)
    assert did and len(did) == 16 and did == device_id(mid) and "0123456789abcdef" not in did
    assert device_id(tmp_path / "missing") is None
    rel = tmp_path / "os-release"
    rel.write_text('NAME="SteamOS"\nPRETTY_NAME="SteamOS"\nVARIANT_ID=steamdeck\n')
    assert os_name(rel) == "SteamOS"
    rel.write_text("NAME=Bazzite\n")
    assert os_name(rel) == "Bazzite"
    assert os_name(tmp_path / "missing") is None
