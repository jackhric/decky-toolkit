"""Sensitive-path guard, confirm-required tools and audit logging. Run with: ./scripts/test.sh"""
import asyncio
import logging
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "py_modules"))

from aiohttp import ClientError, ClientSession, ClientTimeout, web  # noqa: E402

from decky_toolkit.server import audit  # noqa: E402
from certauth import H, PEER_HEADER, stub_auth  # noqa: E402
from decky_toolkit.server.http import Api  # noqa: E402
from decky_toolkit.server.protocol import McpServer  # noqa: E402
from decky_toolkit.tools import ToolRegistry, build_registry, guard, system  # noqa: E402

STEAM = "/home/deck/.local/share/Steam"


@pytest.mark.parametrize("path", [
    f"{STEAM}/config/loginusers.vdf",
    f"{STEAM}/config/config.vdf",
    f"{STEAM}/ssfn1234567890",
    f"{STEAM}/local.vdf",
    f"{STEAM}/config/htmlcache/Cookies",
    f"{STEAM}/config/htmlcache/Default/Cookies-journal",
    "/home/deck/.steam/steam/config/LoginUsers.vdf",
    f"{STEAM}/config/../config/loginusers.vdf",
    "/home/deck/.ssh/id_ed25519",
    "/root/.ssh/id_rsa",
    "/etc/shadow",
])
def test_sensitive_paths(path):
    assert guard.is_sensitive(path) and guard.is_write_protected(path)
    with pytest.raises(PermissionError):
        guard.check_read(path)
    with pytest.raises(PermissionError):
        guard.check_write(path)


@pytest.mark.parametrize("path", [
    f"{STEAM}/config/libraryfolders.vdf",
    f"{STEAM}/steamapps/libraryfolders.vdf",
])
def test_write_protected_but_readable(path):
    assert not guard.is_sensitive(path) and guard.is_write_protected(path)
    guard.check_read(path)
    with pytest.raises(PermissionError):
        guard.check_write(path)


@pytest.mark.parametrize("path", [
    f"{STEAM}/config/localconfig.vdf.bak.txt",
    f"{STEAM}/steamapps/appmanifest_730.acf",
    f"{STEAM}/logs/console_log.txt",
    "/home/deck/.ssh/id_ed25519.pub",
    "/home/deck/.ssh/known_hosts",
    "/home/deck/homebrew/settings/decky-toolkit/settings.json",
    "/tmp/config.vdf",
])
def test_ordinary_paths(path):
    assert not guard.is_sensitive(path) and not guard.is_write_protected(path)


def test_symlink_to_sensitive_file_is_refused(tmp_path):
    secret = tmp_path / "Steam" / "config" / "loginusers.vdf"
    secret.parent.mkdir(parents=True)
    secret.write_text("users")
    link = tmp_path / "innocent.txt"
    os.symlink(secret, link)
    assert guard.is_sensitive(str(link))


def call(name, **arguments):
    return asyncio.run(build_registry().call(name, arguments))


def test_file_tools_apply_the_guard(tmp_path):
    secret = tmp_path / "Steam" / "config" / "loginusers.vdf"
    secret.parent.mkdir(parents=True)
    secret.write_text("users")
    res = call("read_file", path=str(secret))
    assert res["isError"] and res["content"][0]["text"].startswith("PermissionError: refusing to read")
    assert "Traceback" not in res["content"][0]["text"]
    res = call("write_file", path=str(tmp_path / "Steam" / "config" / "libraryfolders.vdf"), content="x")
    assert res["isError"] and "refusing to write" in res["content"][0]["text"]
    assert not (tmp_path / "Steam" / "config" / "libraryfolders.vdf").exists()
    ok = tmp_path / "notes.txt"
    assert not call("write_file", path=str(ok), content="hi")["isError"]
    assert "hi" in call("read_file", path=str(ok))["content"][0]["text"]


def test_confirm_required(monkeypatch):
    restarts = []

    async def fake_restart():
        restarts.append(1)

    monkeypatch.setattr(system, "schedule_loader_restart", fake_restart)
    for args in ({}, {"confirm": False}, {"confirm": "true"}):
        res = call("restart_loader", **args)
        assert res["isError"] and "confirm: true" in res["content"][0]["text"]
    assert restarts == []
    assert not call("restart_loader", confirm=True)["isError"] and restarts == [1]

    res = call("install_plugin", path="/nonexistent.zip")
    assert res["isError"] and "confirm: true" in res["content"][0]["text"]
    res = call("install_plugin", path="/nonexistent.zip", restart="loader", confirm=True)
    assert res["isError"] and res["content"][0]["text"].startswith("FileNotFoundError")
    res = call("install_plugin", path="/nonexistent.zip", restart="none")
    assert res["isError"] and res["content"][0]["text"].startswith("FileNotFoundError")

    described = {t["name"]: t for t in build_registry().describe()}
    assert "confirm: true" in described["restart_loader"]["description"]
    assert "confirm: true" in described["install_plugin"]["description"]
    assert described["restart_loader"]["inputSchema"]["required"] == ["confirm"]


def test_audit_line_lists_known_keys_only():
    token = audit.request_origin.set(("10.0.0.5", "mcp", "VS Code on box"))
    try:
        line = audit.tool_line("write_file", {"path": "/x", "content": "s3cret", "evil key=1": "v"}, ["path", "content", "mode"])
    finally:
        audit.request_origin.reset(token)
    assert line == 'audit tool=write_file origin=10.0.0.5 client="VS Code on box" via=mcp args=content,path+1 unknown'
    assert "s3cret" not in line and "/x" not in line
    assert audit.tool_line("restart_loader", {}, []) == 'audit tool=restart_loader origin=- client="-" via=local args=-'
    assert audit.is_audited("input_mouse") and audit.is_audited("cef_evaluate") and not audit.is_audited("cef_console")




def test_audit_log_lines_over_http(caplog):
    log = logging.getLogger("audit-test")
    reg = ToolRegistry()

    @reg.add("cef_evaluate", "x", {"properties": {"expression": {"type": "string"}}})
    async def cef_evaluate(expression: str) -> str:
        return "ok"

    @reg.add("cef_targets", "x")
    async def cef_targets() -> list:
        return []

    async def run():
        api = Api(auth=stub_auth(), mcp=McpServer(reg, log), capturer=None, logger=log)
        runner = web.AppRunner(api.build_app())
        await runner.setup()
        await web.TCPSite(runner, "127.0.0.1", 0).start()
        base = f"http://127.0.0.1:{runner.addresses[0][1]}"
        try:
            async with ClientSession(timeout=ClientTimeout(total=5)) as s:
                for name, args in (("cef_evaluate", {"expression": "document.cookie"}), ("cef_targets", {})):
                    rpc = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": args}}
                    async with s.post(f"{base}/mcp", json=rpc, headers=H) as r:
                        assert not (await r.json())["result"]["isError"]
                async with s.post(f"{base}/plugins/nope/reload", headers=H) as r:
                    assert r.status in (400, 404, 502)
                async with s.post(f"{base}/mcp", json={}) as r:
                    assert r.status == 401
        finally:
            await runner.cleanup()

    with caplog.at_level(logging.INFO, logger="audit-test"):
        asyncio.run(run())
    lines = [r.getMessage() for r in caplog.records if r.getMessage().startswith("audit")]
    assert lines == ['audit tool=cef_evaluate origin=127.0.0.1 client="test client" via=mcp args=expression',
                     'audit route=POST /plugins/nope/reload origin=127.0.0.1 client="test client" via=http']
    assert not any("document.cookie" in r.getMessage() for r in caplog.records)


def test_forgetting_a_client_closes_only_its_open_streams():
    auth = stub_auth()
    fp, other = H[PEER_HEADER], "cd" * 32
    auth.clients.add(other, "second client", "mcp")
    H2 = {PEER_HEADER: other}

    async def stream(request):
        resp = web.StreamResponse()
        await resp.prepare(request)
        with auth.connections.watching_screen():
            while True:
                await resp.write(b"frame\n")
                await asyncio.sleep(0.05)

    async def drain(r):
        try:
            while await r.content.readline():
                pass
        except ClientError:
            pass

    async def run():
        app = web.Application(middlewares=[auth.middleware()])
        app.router.add_get("/stream", stream)
        runner = web.AppRunner(app, shutdown_timeout=0.5)
        await runner.setup()
        await web.TCPSite(runner, "127.0.0.1", 0).start()
        base = f"http://127.0.0.1:{runner.addresses[0][1]}"
        try:
            async with ClientSession(timeout=ClientTimeout(total=5)) as s, \
                    ClientSession(timeout=ClientTimeout(total=5)) as s2:
                async with s.get(f"{base}/stream", headers=H) as r, s2.get(f"{base}/stream", headers=H2) as r2:
                    assert await r.content.readline() == b"frame\n"
                    assert await r2.content.readline() == b"frame\n"
                    assert auth.connections.count(fp) == 1 and auth.connections.count(other) == 1
                    assert auth.connections.streaming(fp) and auth.connections.streaming(other)
                    assert auth.clients.remove(fp) and auth.connections.close(fp) == 1
                    await asyncio.wait_for(drain(r), 1)
                    for _ in range(3):
                        assert await r2.content.readline() == b"frame\n", "the other client keeps streaming"
                    assert auth.connections.count(other) == 1
                async with s.get(f"{base}/stream", headers=H) as r:
                    assert r.status == 401
            for _ in range(20):
                if not auth.connections.streaming(other):
                    break
                await asyncio.sleep(0.05)
            assert auth.connections.count(fp) == 0 and not auth.connections.streaming(fp)
            assert not auth.connections.streaming(other), "a closed stream no longer counts as streaming"
        finally:
            await runner.cleanup()

    asyncio.run(run())
