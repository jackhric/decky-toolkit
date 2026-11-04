"""Sensitive-path guard, confirm-required tools and audit logging. Run with: ./scripts/test.sh"""
import asyncio
import logging
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "py_modules"))

from aiohttp import ClientSession, ClientTimeout, web  # noqa: E402

from decky_mcp import audit  # noqa: E402
from decky_mcp.auth import TokenAuth  # noqa: E402
from decky_mcp.http import Api  # noqa: E402
from decky_mcp.protocol import McpServer  # noqa: E402
from decky_mcp.tools import ToolRegistry, build_registry, guard, system  # noqa: E402

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
    "/home/deck/homebrew/settings/decky-mcp/settings.json",
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
    token = audit.request_origin.set(("10.0.0.5", "mcp"))
    try:
        line = audit.tool_line("write_file", {"path": "/x", "content": "s3cret", "evil key=1": "v"}, ["path", "content", "mode"])
    finally:
        audit.request_origin.reset(token)
    assert line == "audit tool=write_file origin=10.0.0.5 via=mcp args=content,path+1 unknown"
    assert "s3cret" not in line and "/x" not in line
    assert audit.tool_line("restart_loader", {}, []) == "audit tool=restart_loader origin=- via=local args=-"
    assert audit.is_audited("input_mouse") and audit.is_audited("cef_evaluate") and not audit.is_audited("cef_console")


TOKEN = "t"
H = {"Authorization": f"Bearer {TOKEN}"}


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
        api = Api(auth=TokenAuth(TOKEN), mcp=McpServer(reg, log), capturer=None, static_dir=None, logger=log)
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
    assert lines == ["audit tool=cef_evaluate origin=127.0.0.1 via=mcp args=expression",
                     "audit route=POST /plugins/nope/reload origin=127.0.0.1 via=http"]
    assert not any("document.cookie" in r.getMessage() for r in caplog.records)
