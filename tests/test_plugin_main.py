"""main.py's Plugin: start and stop, rebinding when the port or the enabled switch changes, and the event sources the
services report to. A fake `decky` module stands in for the loader. Run with: ./scripts/test.sh"""
import asyncio
import importlib.util
import json
import logging
import socket
import ssl
import sys
import types
from pathlib import Path

import pytest

from aiohttp import ClientSession, ClientTimeout, TCPConnector

from certauth import PUBLIC_KEY
from decky_toolkit import diagnostics

ROOT = Path(__file__).resolve().parents[1]


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture
def plugin(tmp_path, monkeypatch):
    emitted: list[tuple] = []

    async def emit(name, *args):
        emitted.append((name, *args))

    decky = types.ModuleType("decky")
    decky.DECKY_PLUGIN_DIR = str(ROOT)
    decky.DECKY_PLUGIN_SETTINGS_DIR = str(tmp_path / "settings")
    decky.DECKY_PLUGIN_RUNTIME_DIR = str(tmp_path / "runtime")
    decky.logger = logging.getLogger("decky-test")
    decky.emit = emit
    (tmp_path / "runtime").mkdir()
    (tmp_path / "settings").mkdir()
    (tmp_path / "settings/settings.json").write_text(json.dumps({"bind": "127.0.0.1", "port": free_port()}))
    monkeypatch.setitem(sys.modules, "decky", decky)
    monkeypatch.setenv("DECKY_HOME", str(tmp_path / "decky"))
    spec = importlib.util.spec_from_file_location("decky_toolkit_main", ROOT / "main.py")
    main = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(main)
    # Process-wide watchdogs: the loader one exits the process when its parent is not the loader.
    monkeypatch.setattr(main, "_loader_watchdog", lambda: None)
    monkeypatch.setattr(diagnostics, "install", lambda *a, **k: None)
    p = main.Plugin()
    p.emitted, p.settings_dir = emitted, decky.DECKY_PLUGIN_SETTINGS_DIR
    return p


def tls() -> ssl.SSLContext:
    ctx = ssl.create_default_context()
    ctx.check_hostname, ctx.verify_mode = False, ssl.CERT_NONE
    return ctx


async def health(port: int) -> int | None:
    try:
        async with ClientSession(connector=TCPConnector(ssl=tls()), timeout=ClientTimeout(total=3)) as s:
            async with s.get(f"https://127.0.0.1:{port}/health") as r:
                return r.status
    except OSError:
        return None


def test_start_rebind_disable_and_unload(plugin):
    async def run():
        await plugin._main()
        try:
            status = await plugin.get_status()
            first = plugin.settings.port
            assert status["running"] and status["error"] is None and status["port"] == first
            assert await health(first) == 200
            assert set(status) >= {"stream", "input", "clients", "pair_requests"}
            assert status["version"] == json.loads((ROOT / "package.json").read_text())["version"]

            second = free_port()
            assert (await plugin.set_port(second))["running"]
            assert await health(second) == 200 and await health(first) is None, "rebinding closes the old port"
            assert json.loads((Path(plugin.settings_dir) / "settings.json").read_text())["port"] == second
            with pytest.raises(ValueError):
                await plugin.set_port(80)

            assert not (await plugin.set_enabled(False))["running"]
            assert await health(second) is None
            assert (await plugin.set_enabled(True))["running"] and await health(second) == 200
            assert (await plugin.restart_server())["running"]
        finally:
            await plugin._unload()
        assert plugin.runner is None and await health(plugin.settings.port) is None
        assert plugin.services.plugin_tools._task is None, "_unload stops the services"
    asyncio.run(run())


def test_event_sources_and_what_services_report(plugin):
    async def run():
        await plugin._main()
        try:
            hub, s = plugin.events, plugin.services
            assert set(hub.sources) == {"stream_settings", "input_settings", "plugins", "controllers", "pairing", "tools",
                                       "ui_tweaks"}
            hello = await hub.snapshot()
            assert hello["stream_settings"]["fps"] == 30 and hello["input_settings"]["enabled"] is False
            assert hello["pairing"] == {"pending": 0, "paired": 0} and hello["plugins"] == {"plugins": []}
            assert len(hello["tools"]["hash"]) == 16

            with hub.subscribe() as sub:
                await s.capturer.update_settings(fps=15)
                await s.input.set_enabled(True)
                req = s.pairing.create("VS Code", "vscode", PUBLIC_KEY, "10.0.0.2")
                await asyncio.sleep(0.05)
                frames = []
                while not sub.queue.empty():
                    frames.append(sub.queue.get_nowait())
            names = [f.split(b"\n", 1)[0] for f in frames]
            assert b"event: stream_settings" in names and b"event: input_settings" in names and b"event: pairing" in names
            assert any(b'"pending":1' in f for f in frames if f.startswith(b"event: pairing"))

            sent = [e[0] for e in plugin.emitted]
            assert "decky_toolkit_input_state" in sent and "decky_toolkit_pair_request" in sent
            assert ("decky_toolkit_pair_request", {"id": req.id, "code": req.code, "client_name": "VS Code",
                                                   "client_kind": "vscode", "remote": "10.0.0.2"}) in plugin.emitted
            await plugin.approve_pair_request(req.id)
            await asyncio.sleep(0.01)
            assert [c["name"] for c in await plugin.list_paired_clients()] == ["VS Code"]
            assert ("decky_toolkit_paired", "10.0.0.2", "VS Code") in plugin.emitted
            assert any(e[0] == "decky_toolkit_paired_clients" for e in plugin.emitted)
            assert (await hub.snapshot())["pairing"] == {"pending": 0, "paired": 1}

            assert (await plugin.get_status())["ui_tweaks_off"] == []
            status = await plugin.set_ui_tweak("top-bar-icon", False)
            await asyncio.sleep(0.01)
            assert status["ui_tweaks_off"] == ["top-bar-icon"]
            assert ("decky_toolkit_ui_tweaks", ["top-bar-icon"]) in plugin.emitted
            assert (await hub.snapshot())["ui_tweaks"] == {"off": ["top-bar-icon"]}
            saved = json.loads((Path(plugin.settings_dir) / "settings.json").read_text())
            assert saved["ui_tweaks_off"] == ["top-bar-icon"]
        finally:
            await plugin._unload()
    asyncio.run(run())
