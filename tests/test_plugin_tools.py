"""Tools other plugins register from their frontend: naming, calls through the registry, error stacks. Run with:
./scripts/test.sh"""
import asyncio
import json
import logging
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "py_modules"))

from decky_toolkit.loader import sourcemap  # noqa: E402
from decky_toolkit.tools import build_registry  # noqa: E402
from decky_toolkit.tools.plugin_tools import PluginTools, prefix_of  # noqa: E402

URL = "http://127.0.0.1:1337/plugins/My%20Plugin/dist/index.js?t=1"
SCHEMA = {"type": "object", "properties": {"appid": {"type": "number"}}, "required": ["appid"], "additionalProperties": False}


def run(coro):
    return asyncio.run(coro)


def text(result: dict) -> str:
    return result["content"][0]["text"]


class FakeTab:
    def __init__(self, reply: dict):
        self.reply = reply
        self.expressions: list[str] = []

    async def evaluate(self, expression: str, await_promise: bool = True, timeout: float = 15):
        self.expressions.append(expression)
        return json.dumps(self.reply)


@pytest.fixture
def plugins(tmp_path, monkeypatch):
    monkeypatch.setenv("DECKY_HOME", str(tmp_path))
    for d, name in (("my-plugin", "My Plugin"), ("Screen", "Screen Thing"), ("other", "Other"), ("x" * 60, "Long")):
        (tmp_path / "plugins" / d / "dist").mkdir(parents=True)
        (tmp_path / "plugins" / d / "plugin.json").write_text(json.dumps({"name": name}))
    return tmp_path / "plugins"


def registered(plugin: str, name: str, **extra) -> dict:
    return {"plugin": plugin, "name": name, "description": f"{name} it.", "inputSchema": SCHEMA, **extra}


def attached(*tools: dict, tab: FakeTab | None = None):
    pt = PluginTools(logging.getLogger("t"))
    reg = build_registry(plugin_tools=pt)
    pt._registered = list(tools)
    pt._resolve()
    pt._tab = tab
    return reg, pt


def test_prefix_from_directory():
    assert prefix_of("my-plugin") == "my_plugin"
    assert prefix_of("Decky Recorder!") == "decky_recorder"
    assert prefix_of("---") == ""


def test_names_and_refusals(plugins):
    reg, pt = attached(
        registered("My Plugin", "reset_cache", annotations={"readOnlyHint": True}),
        registered("My Plugin", "Bad-Name"),
        registered("Screen Thing", "grab"),
        registered("Long", "tool"),
        registered("Gone", "tool"),
        registered("Other", "x"),
        registered("Other", "x"),
    )
    listed = {t["name"]: t for t in reg.describe()}
    assert listed["my_plugin_reset_cache"]["description"] == "reset_cache it. (from the Decky plugin My Plugin)"
    assert listed["my_plugin_reset_cache"]["annotations"] == {"readOnlyHint": True}
    assert "other_x" in listed and len(reg) == len(reg.names()) + 2
    refused = {(r["plugin"], r["name"]): r["reason"] for r in pt._refused}
    assert "lowercase" in refused[("My Plugin", "Bad-Name")]
    assert "built-in tool area" in refused[("Screen Thing", "grab")]
    assert "longer than 64" in refused[("Long", "tool")]
    assert "no installed plugin" in refused[("Gone", "tool")]
    assert "already a tool of Other" in refused[("Other", "x")]
    assert pt.of_plugin("my-plugin") == {"tools": ["my_plugin_reset_cache"], "refused": [
        {"name": "Bad-Name", "reason": "tool names are lowercase letters, digits and _"}]}
    assert pt.of_plugin("nothing") is None
    lists = json.loads(text(run(reg.call("plugin_list", {}))))
    assert {p["dir"]: p.get("mcp_tools") for p in lists}["my-plugin"]["tools"] == ["my_plugin_reset_cache"]


def test_fingerprint_follows_plugin_tools(plugins):
    reg, pt = attached()
    before = reg.fingerprint()
    pt._registered = [registered("My Plugin", "reset_cache")]
    pt._resolve()
    assert reg.fingerprint() != before


def test_calls_check_arguments_then_run_in_the_page(plugins, caplog):
    tab = FakeTab({"value": {"cleared": 3}})
    reg, _ = attached(registered("My Plugin", "reset_cache", outputSchema={"type": "object"}), tab=tab)
    reg.log = logging.getLogger("t")
    r = run(reg.call("my_plugin_reset_cache", {"appid": 1, "extra": 2}))
    assert r["isError"] and "unknown argument 'extra'" in text(r) and not tab.expressions
    r = run(reg.call("my_plugin_reset_cache", {}))
    assert r["isError"] and "missing required 'appid'" in text(r)
    with caplog.at_level(logging.INFO, "t"):
        r = run(reg.call("my_plugin_reset_cache", {"appid": 7}))
    assert not r.get("isError") and r["structuredContent"] == {"cleared": 3}
    assert '"My Plugin", "reset_cache", {"appid": 7}' in tab.expressions[0]
    assert "audit tool=my_plugin_reset_cache" in caplog.text and "args=appid" in caplog.text and "7" not in caplog.text.split("args=")[1]


def test_page_side_failures(plugins):
    reg, pt = attached(registered("My Plugin", "reset_cache"), tab=FakeTab({"invalid": "appid: expected number"}))
    r = run(reg.call("my_plugin_reset_cache", {"appid": "x"}))
    assert r["isError"] and text(r) == "Invalid arguments for my_plugin_reset_cache: appid: expected number"
    pt._tab = FakeTab({"gone": True})
    r = run(reg.call("my_plugin_reset_cache", {"appid": 1}))
    assert r["isError"] and "is gone" in text(r) and pt._dirty.is_set()
    pt._tab = None
    r = run(reg.call("my_plugin_reset_cache", {"appid": 1}))
    assert r["isError"] and "not reachable" in text(r)


def test_error_stack_is_source_mapped(plugins):
    (plugins / "my-plugin" / "dist" / "index.js.map").write_text(json.dumps(
        {"version": 3, "sources": ["../src/tools.ts"], "mappings": "AAAA,UAAU;AACV"}))
    stack = f"Error: nope\n    at execute ({URL}:1:12)\n    at {URL}:2:1"
    reg, _ = attached(registered("My Plugin", "reset_cache"),
                      tab=FakeTab({"error": {"name": "Error", "message": "nope", "stack": stack}}))
    r = run(reg.call("my_plugin_reset_cache", {"appid": 1}))
    assert r["isError"] and text(r) == "Error: nope\n    at execute (src/tools.ts:1:11)\n    at src/tools.ts:2:1"


def test_sourcemap_leaves_unknown_frames_alone(plugins):
    line = f"at f ({URL}:1:1)"
    assert sourcemap.map_stack(line, lambda name: None) == line


def test_navigation_and_binding_mark_the_registry_dirty():
    pt = PluginTools(logging.getLogger("t"))
    pt._on_event({"method": "Page.frameNavigated", "params": {"frame": {"id": "a", "parentId": "b"}}})
    assert not pt._dirty.is_set()
    pt._on_event({"method": "Page.frameNavigated", "params": {"frame": {"id": "a"}}})
    assert pt._dirty.is_set()
    pt._dirty.clear()
    pt._on_event({"method": "Runtime.bindingCalled", "params": {"name": "__deckyToolkitToolsChanged", "payload": ""}})
    assert pt._dirty.is_set()
