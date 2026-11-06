"""plugin_methods, plugin_frontend_check and plugin_call. Run with: ./scripts/test.sh"""
import asyncio
import json
import shutil
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "py_modules"))

from decky_toolkit.steam import cdp  # noqa: E402
from decky_toolkit.tools import build_registry, plugin_api  # noqa: E402

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "sample_plugin"


@pytest.fixture
def plugins(tmp_path, monkeypatch):
    monkeypatch.setenv("DECKY_HOME", str(tmp_path))
    root = tmp_path / "plugins"
    shutil.copytree(FIXTURE, root / "sample")
    return root


def call(name, **arguments):
    return asyncio.run(build_registry().call(name, arguments))


def test_plugin_methods_parses_public_async_methods(plugins):
    info = plugin_api.plugin_methods("sample")
    assert info["file"].endswith("sample/main.py")
    by_name = {m["name"]: m for m in info["methods"]}
    assert list(by_name) == ["get_status", "set_volume", "log_many"]
    assert by_name["get_status"]["args"] == [] and by_name["get_status"]["doc"] == "Report the plugin state."
    assert by_name["set_volume"]["args"] == [
        {"name": "level", "annotation": "int"},
        {"name": "fade", "annotation": "float", "default": "0.5"},
        {"name": "channel", "annotation": "str", "default": "'main'"},
    ]
    assert [a["name"] for a in by_name["log_many"]["args"]] == ["*lines", "**extra"]
    assert by_name["log_many"]["doc"] is None and by_name["set_volume"]["line"] == 18

    for bad in ("", "../etc", ".hidden"):
        with pytest.raises(ValueError):
            plugin_api.plugin_methods(bad)
    with pytest.raises(FileNotFoundError):
        plugin_api.plugin_methods("nope")
    (plugins / "sample" / "main.py").write_text("class Plugin(:\n")
    with pytest.raises(ValueError, match="does not parse"):
        plugin_api.plugin_methods("sample")
    with pytest.raises(ValueError, match="no top-level class Plugin"):
        plugin_api.methods_from_source("class Other:\n    pass\n")


def test_frontend_check_on_dist_bundle(plugins):
    res = json.loads(call("plugin_frontend_check", plugin="sample")["content"][0]["text"])
    assert res["source"] == "dist" and res["files_scanned"] == 1
    assert res["frontend_calls"] == {"get_status": ["dist/index.js:2"], "ghost": ["dist/index.js:6"],
                                     "missing_method": ["dist/index.js:4"], "set_volume": ["dist/index.js:3"]}
    assert "ghost" in res["missing_backend"] and "missing_method" in res["missing_backend"]
    assert res["unused_backend"] == ["log_many"]


def test_frontend_check_prefers_sources(plugins):
    src = plugins / "sample" / "src" / "components"
    src.mkdir(parents=True)
    (src / "Panel.tsx").write_text('const s = callable<[], Status>("get_status");\nawait call<[number]>("set_volume", 3);\n')
    (plugins / "sample" / "src" / "notes.md").write_text('callable("ignored")')
    res = plugin_api.frontend_check(str(plugins / "sample"), plugin_api.plugin_methods("sample")["methods"])
    assert res["source"] == "src" and res["files_scanned"] == 1
    assert res["frontend_calls"] == {"get_status": ["src/components/Panel.tsx:1"], "set_volume": ["src/components/Panel.tsx:2"]}
    assert res["missing_backend"] == [] and res["unused_backend"] == ["log_many"]


def test_call_plugin_method(monkeypatch, plugins):
    (plugins / "decky-mcp").mkdir()
    (plugins / "decky-mcp" / "plugin.json").write_text('{"name": "Decky Toolkit"}')
    seen = []

    async def fake_eval(title, js, timeout=15):
        seen.append((title, js, timeout))
        if "'boom'" in js or '"boom"' in js:
            return {"ok": False, "error": "Python Exception",
                    "traceback": "Traceback (most recent call last):\n  File \"x\"\nException: port must be 1024-65535\n"}
        return {"ok": True, "result": {"running": True}}

    monkeypatch.setattr(cdp, "evaluate_in", fake_eval)
    res = asyncio.run(plugin_api.call_plugin_method("Decky Toolkit", "get_status", [1, "a"]))
    assert res == {"plugin": "Decky Toolkit", "method": "get_status", "ok": True, "result": {"running": True}}
    title, js, timeout = seen[0]
    assert title is None and timeout == 30
    assert "loader/call_plugin_method" in js and '["Decky Toolkit", "get_status", 1, "a"]' in js

    res = asyncio.run(plugin_api.call_plugin_method("Decky Toolkit", "boom"))
    assert res["ok"] is False and res["error"] == "Exception: port must be 1024-65535" and "Traceback" in res["traceback"]

    for method in ("_main", "_unload", "__init__"):
        out = call("plugin_call", plugin="Decky Toolkit", method=method)
        assert out["isError"] and "starting with '_'" in out["content"][0]["text"]
    for method in sorted(plugin_api.DEVICE_ONLY_METHODS):
        out = call("plugin_call", plugin="Decky Toolkit", method=method, args=["id"])
        assert out["isError"] and "only be used on the device" in out["content"][0]["text"]
    for kwargs in ({"method": "x; alert(1)"}, {"method": "ok", "args": {"a": 1}}, {"method": "ok", "plugin": ""}):
        out = call("plugin_call", **{"plugin": "Decky Toolkit", **kwargs})
        assert out["isError"] and out["content"][0]["text"].startswith("ValueError")
    assert len(seen) == 2


def test_call_plugin_method_redacts_token(monkeypatch):
    status = {"enabled": True, "token": "secret", "url": "http://h:8765/mcp",
              "nested": [{"token": "x", "keep": 1}]}

    async def fake_eval(title, js, timeout=15):
        return {"ok": True, "result": status}

    monkeypatch.setattr(cdp, "evaluate_in", fake_eval)
    res = asyncio.run(plugin_api.call_plugin_method("Decky Toolkit", "get_status"))
    assert res["result"] == {"enabled": True, "url": "http://h:8765/mcp", "nested": [{"keep": 1}]}
    assert "secret" not in json.dumps(res)
