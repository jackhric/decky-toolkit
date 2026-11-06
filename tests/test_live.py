"""loader/live.py and its routes: single-file writes into an installed plugin, reload modes. Run with: ./scripts/test.sh"""
import asyncio
import json
import logging
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "py_modules"))

from aiohttp import ClientSession, ClientTimeout, web  # noqa: E402

from certauth import H, stub_auth  # noqa: E402
from decky_toolkit.loader import live  # noqa: E402
from decky_toolkit.server.http import Api  # noqa: E402
from decky_toolkit.server.protocol import McpServer  # noqa: E402
from decky_toolkit.tools import ToolRegistry  # noqa: E402

LOG = logging.getLogger("t")


@pytest.fixture
def plugin(tmp_path, monkeypatch):
    monkeypatch.setenv("DECKY_HOME", str(tmp_path))
    root = tmp_path / "plugins" / "demo"
    (root / "dist").mkdir(parents=True)
    (root / "plugin.json").write_text(json.dumps({"name": "Demo"}))
    (root / "dist" / "index.js").write_text("old")
    return root


def test_write_file_replaces_and_creates(plugin):
    assert live.write_file("demo", "dist/index.js", b"new") == {"dir": "demo", "path": "dist/index.js", "bytes": 3}
    assert (plugin / "dist" / "index.js").read_bytes() == b"new"
    live.write_file("demo", "py_modules/pkg/mod.py", b"x = 1\n")
    assert (plugin / "py_modules" / "pkg" / "mod.py").read_text() == "x = 1\n"
    assert oct((plugin / "py_modules" / "pkg" / "mod.py").stat().st_mode & 0o777) == "0o644"
    assert not [p for p in plugin.rglob("*.tmp")]


@pytest.mark.parametrize("rel", ["", "/etc/passwd", "../other/main.py", "dist/../../other/x", "dist\\index.js"])
def test_write_file_stays_inside_the_plugin(plugin, rel):
    with pytest.raises(ValueError):
        live.write_file("demo", rel, b"x")


def test_write_file_refuses_symlink_escape_and_protected_files(plugin, tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    (plugin / "link").symlink_to(outside)
    with pytest.raises(ValueError):
        live.write_file("demo", "link/x", b"x")
    with pytest.raises(PermissionError):
        live.write_file("demo", "config/loginusers.vdf", b"x")


def test_write_file_needs_an_installed_plugin(plugin):
    with pytest.raises(FileNotFoundError):
        live.write_file("missing", "dist/index.js", b"x")
    with pytest.raises(ValueError):
        live.write_file("../demo", "dist/index.js", b"x")


def test_reload_rejects_unknown_mode(plugin):
    with pytest.raises(ValueError):
        asyncio.run(live.reload("demo", "everything"))


def test_reload_builds_its_scripts_and_restores_the_right_tab(plugin, monkeypatch):
    calls = []

    async def evaluate_in(title, expr, timeout=15):
        calls.append((title, expr))
        if expr.startswith("(() => ({ header"):
            return {"header": "Paired devices", "focus": "Paired devices"} if title == live.QUICK_ACCESS else None
        if title is None:
            return {"load_ms": 9, "reloaded": True, "errors": [], "restored": ["panel"], "routes": [], "menu": 2}
        return ["tab Paired devices"]

    monkeypatch.setattr(live.cdp, "evaluate_in", evaluate_in)
    result = asyncio.run(live.reload("demo", "frontend"))
    assert result == {"dir": "demo", "name": "Demo", "mode": "frontend", "load_ms": 9, "reloaded": True,
                      "errors": [], "restored": ["panel", "tab Paired devices"], "routes": []}
    reload_expr = next(e for t, e in calls if t is None)
    assert '})("Demo", "frontend")' in reload_expr and "__NAME__" not in reload_expr
    restore = calls[-1]
    assert restore[0] == live.QUICK_ACCESS and '"header": "Paired devices"' in restore[1]


def test_reload_leaves_focus_alone_outside_the_plugin(plugin, monkeypatch):
    titles = []

    async def evaluate_in(title, expr, timeout=15):
        titles.append(title)
        if expr.startswith("(() => ({ header"):
            return {"header": None, "focus": "2"}
        return {"load_ms": 9, "reloaded": True, "errors": [], "restored": [], "routes": [], "menu": 0}

    monkeypatch.setattr(live.cdp, "evaluate_in", evaluate_in)
    assert asyncio.run(live.reload("demo", "frontend"))["restored"] == []
    assert titles.count(None) == 1 and len(titles) == 3


def test_routes(plugin):
    async def run():
        api = Api(auth=stub_auth(), mcp=McpServer(ToolRegistry(), LOG), capturer=None, logger=LOG)
        runner = web.AppRunner(api.build_app())
        await runner.setup()
        await web.TCPSite(runner, "127.0.0.1", 0).start()
        base = f"http://127.0.0.1:{runner.addresses[0][1]}"
        try:
            async with ClientSession(timeout=ClientTimeout(total=10)) as s:
                async with s.put(f"{base}/api/v1/plugins/demo/files?path=dist/index.js", data=b"fresh", headers=H) as r:
                    assert r.status == 200 and (await r.json())["bytes"] == 5
                async with s.put(f"{base}/api/v1/plugins/demo/files?path=../x", data=b"x", headers=H) as r:
                    assert r.status == 400
                async with s.put(f"{base}/api/v1/plugins/demo/files?path=config/loginusers.vdf", data=b"x", headers=H) as r:
                    assert r.status == 403
                async with s.put(f"{base}/api/v1/plugins/missing/files?path=a", data=b"x", headers=H) as r:
                    assert r.status == 404
                async with s.put(f"{base}/api/v1/plugins/demo/files?path=dist/index.js", data=b"x") as r:
                    assert r.status == 401
                async with s.post(f"{base}/api/v1/plugins/demo/reload?mode=bogus", headers=H) as r:
                    assert r.status == 400
        finally:
            await runner.cleanup()
        assert (plugin / "dist" / "index.js").read_bytes() == b"fresh"

    asyncio.run(run())
