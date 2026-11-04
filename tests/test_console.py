"""Steam UI console capture: event rendering, ring buffer, queries, routes. Run with: ./scripts/test.sh"""
import asyncio
import json
import logging
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "py_modules"))

from aiohttp import ClientSession, ClientTimeout, web  # noqa: E402

from decky_mcp.auth import TokenAuth  # noqa: E402
from decky_mcp.console import ConsoleCollector, parse_event, render_args, render_remote_object  # noqa: E402
from decky_mcp.http import Api  # noqa: E402
from decky_mcp.protocol import McpServer  # noqa: E402
from decky_mcp.tools import build_registry  # noqa: E402

LOG = logging.getLogger("t")
TS = 1_793_000_000_000.0  # ms, as CDP sends


def console_msg(kind, *args, ts=TS, frames=None):
    params = {"type": kind, "args": list(args), "executionContextId": 1, "timestamp": ts}
    if frames is not None:
        params["stackTrace"] = {"callFrames": frames}
    return {"method": "Runtime.consoleAPICalled", "params": params}


def s(v):
    return {"type": "string", "value": v}


def test_render_remote_objects():
    assert render_remote_object(s("hi")) == "hi"
    assert render_remote_object(s("hi"), top=False) == "'hi'"
    assert render_remote_object({"type": "number", "value": 42}) == "42"
    assert render_remote_object({"type": "number", "unserializableValue": "NaN"}) == "NaN"
    assert render_remote_object({"type": "boolean", "value": False}) == "false"
    assert render_remote_object({"type": "undefined"}) == "undefined"
    assert render_remote_object({"type": "object", "subtype": "null", "value": None}) == "null"
    assert render_remote_object({"type": "function", "description": "function f(a) {\n  return a;\n}"}) == "function f(a) {"
    err = {"type": "object", "subtype": "error", "className": "Error", "description": "Error: x\n    at f (a.js:1:2)",
           "preview": {"type": "object", "subtype": "error", "properties": []}}
    assert render_remote_object(err) == "Error: x\n    at f (a.js:1:2)"
    obj = {"type": "object", "className": "Object", "description": "Object", "preview": {
        "type": "object", "description": "Object", "overflow": False, "properties": [
            {"name": "a", "type": "number", "value": "1"},
            {"name": "b", "type": "object", "subtype": "array", "value": "Array(2)"},
            {"name": "s", "type": "string", "value": "x"},
            {"name": "n", "type": "object", "valuePreview": {"type": "object", "description": "Object",
                                                             "properties": [{"name": "z", "type": "boolean", "value": "true"}]}}]}}
    assert render_remote_object(obj) == "{a: 1, b: Array(2), s: 'x', n: {z: true}}"
    arr = {"type": "object", "subtype": "array", "description": "Array(3)", "preview": {
        "type": "object", "subtype": "array", "description": "Array(3)", "overflow": True,
        "properties": [{"name": "0", "type": "number", "value": "1"}, {"name": "1", "type": "string", "value": "a"}]}}
    assert render_remote_object(arr) == "[1, 'a', …]"
    cls = {"type": "object", "className": "Foo", "description": "Foo", "preview": {"type": "object", "description": "Foo", "properties": []}}
    assert render_remote_object(cls) == "Foo"
    m = {"type": "object", "subtype": "map", "description": "Map(1)", "preview": {
        "type": "object", "subtype": "map", "description": "Map(1)", "properties": [],
        "entries": [{"key": {"type": "string", "description": "k", "properties": []},
                     "value": {"type": "number", "description": "2", "properties": []}}]}}
    assert render_remote_object(m) == "Map(1) {k => 2}"


def test_render_args_format_specifiers():
    # Decky's logger: '%c Decky %c WSRouter %c', css, css, css, message
    args = [s("%c Decky %c WSRouter %c"), s("color: red"), s("color: blue"), s(""), s("Calling PY method")]
    assert render_args(args) == " Decky  WSRouter  Calling PY method"
    assert render_args([s("%s is %d%%"), s("x"), {"type": "number", "value": 4.7}]) == "x is 4%"
    assert render_args([s("%o and %s"), s("only one")]) == "only one and %s"
    assert render_args([s("a"), {"type": "number", "value": 1}, s("b")]) == "a 1 b"
    assert render_args([]) == ""


def test_parse_console_exception_and_log_events():
    frame = {"functionName": "warnIt", "scriptId": "1", "url": "https://x/app.js", "lineNumber": 9, "columnNumber": 4}
    e = parse_event(**{"method": "Runtime.consoleAPICalled", "params": console_msg("warning", s("decky-mcp test"), frames=[frame])["params"]})
    assert (e["source"], e["type"], e["level"], e["text"]) == ("console", "warning", "warn", "decky-mcp test")
    assert (e["url"], e["line"], e["column"], e["function"]) == ("https://x/app.js", 10, 5, "warnIt")
    assert e["ts"] == TS / 1000 and e["time"].startswith("2026-")
    assert parse_event("Runtime.consoleAPICalled", {"type": "assert", "args": []})["level"] == "error"
    assert parse_event("Runtime.consoleAPICalled", {"type": "debug", "args": []})["level"] == "debug"
    assert parse_event("Runtime.consoleAPICalled", {"type": "table", "args": []})["level"] == "log"

    exc = parse_event("Runtime.exceptionThrown", {"timestamp": TS, "exceptionDetails": {
        "exceptionId": 1, "text": "Uncaught", "lineNumber": 0, "columnNumber": 25, "url": "https://x/a.js",
        "exception": {"type": "object", "subtype": "error", "className": "Error",
                      "description": "Error: decky-mcp boom\n    at <anonymous>:1:26"}}})
    assert (exc["source"], exc["level"]) == ("exception", "error")
    assert exc["text"] == "Uncaught Error: decky-mcp boom\n    at <anonymous>:1:26"
    assert (exc["url"], exc["line"], exc["column"]) == ("https://x/a.js", 1, 26)
    thrown_string = parse_event("Runtime.exceptionThrown", {"timestamp": TS, "exceptionDetails": {
        "text": "Uncaught", "exception": {"type": "string", "value": "plain"}}})
    assert thrown_string["text"] == "Uncaught plain" and "url" not in thrown_string

    log = parse_event("Log.entryAdded", {"entry": {"source": "network", "level": "error", "text": "Failed to load resource",
                                                   "timestamp": TS, "url": "https://x/img.jpg"}})
    assert (log["source"], log["type"], log["level"], log["url"]) == ("log", "network", "error", "https://x/img.jpg")
    assert "line" not in log
    assert parse_event("Log.entryAdded", {"entry": {"level": "verbose", "text": "v"}})["level"] == "debug"
    assert parse_event("Runtime.executionContextCreated", {}) is None
    assert len(parse_event("Runtime.consoleAPICalled", {"type": "log", "args": [s("x" * 20000)]})["text"]) < 8100


def test_ring_buffer_query_filters_and_clear():
    c = ConsoleCollector(LOG, targets=("SharedJSContext", "Steam Big Picture Mode"), size=5)
    for i in range(8):
        c.handle_message("SharedJSContext", console_msg("log", s(f"line {i}"), ts=TS + i * 1000))
    c.handle_message("SharedJSContext", console_msg("warning", s("careful"), ts=TS + 9000))
    c.handle_message("SharedJSContext", console_msg("error", s("broken"), ts=TS + 10000))
    for i in range(7):
        c.handle_message("SharedJSContext", console_msg("debug", s(f"WSRouter {i}"), ts=TS + 11000 + i))
    c.handle_message("steam big picture mode", console_msg("log", s("bpm"), ts=TS + 12000))

    res = c.query()
    assert res["target"] == "SharedJSContext"
    assert [e["text"] for e in res["entries"]] == ["line 5", "line 6", "line 7", "careful", "broken"]
    assert "ts" not in res["entries"][0] and res["entries"][0]["target"] == "SharedJSContext"
    st = res["status"][0]
    assert (st["buffered"], st["buffered_debug"], st["dropped"]) == (5, 5, 7)
    # The debug flood has its own ring, so it never pushed out the error.
    assert [e["text"] for e in c.query(level="debug", lines=3)["entries"]] == ["WSRouter 4", "WSRouter 5", "WSRouter 6"]
    assert [e["text"] for e in c.query(level="warn")["entries"]] == ["careful", "broken"]
    assert [e["text"] for e in c.query(level="error")["entries"]] == ["broken"]
    assert [e["text"] for e in c.query(lines=2)["entries"]] == ["careful", "broken"]
    assert [e["text"] for e in c.query(grep="BROK")["entries"]] == ["broken"]

    careful_id = c.query(level="warn")["entries"][0]["id"]
    assert [e["text"] for e in c.query(since=careful_id)["entries"]] == ["broken"]
    assert [e["text"] for e in c.query(since=str(careful_id))["entries"]] == ["broken"]
    iso = c.query(level="warn")["entries"][0]["time"]
    assert [e["text"] for e in c.query(since=iso)["entries"]] == ["broken"]
    assert c.query()["last_id"] == c.query(level="debug")["entries"][-1]["id"]

    both = c.query(target="all", lines=3)
    assert both["target"] == "all" and [e["text"] for e in both["entries"]] == ["careful", "broken", "bpm"]
    assert c.query(target="Steam Big Picture Mode")["entries"][0]["target"] == "Steam Big Picture Mode"

    for bad in ({"target": "QuickAccess"}, {"level": "loud"}, {"since": "yesterday"}, {"since": True}):
        with pytest.raises(ValueError):
            c.query(**bad)

    assert c.clear("SharedJSContext") == {"SharedJSContext": 10}
    assert c.query()["entries"] == [] and c.query(target="Steam Big Picture Mode")["count"] == 1
    assert c.clear() == {"SharedJSContext": 0, "Steam Big Picture Mode": 1}


def test_reconnect_cutoff_skips_replayed_messages():
    c = ConsoleCollector(LOG, targets=("SharedJSContext",))
    c.handle_message("SharedJSContext", console_msg("log", s("old"), ts=TS))
    cutoff = TS / 1000
    assert c.handle_message("SharedJSContext", console_msg("log", s("old"), ts=TS), cutoff) is None
    assert c.handle_message("SharedJSContext", console_msg("log", s("new"), ts=TS + 1), cutoff)["text"] == "new"
    assert c.handle_message("SharedJSContext", {"id": 3, "result": {}}) is None


def test_follow_replays_tail_then_streams_live():
    async def run():
        c = ConsoleCollector(LOG, targets=("SharedJSContext", "Steam Big Picture Mode"))
        for i in range(4):
            c.handle_message("SharedJSContext", console_msg("log", s(f"old {i}"), ts=TS + i))
        stream = c.follow("SharedJSContext", tail=2, level="info")
        got = [await anext(stream), await anext(stream)]
        c.handle_message("SharedJSContext", console_msg("debug", s("hidden"), ts=TS + 10))
        c.handle_message("Steam Big Picture Mode", console_msg("log", s("other tab"), ts=TS + 11))
        c.handle_message("SharedJSContext", console_msg("error", s("live"), ts=TS + 12))
        got.append(await asyncio.wait_for(anext(stream), 1))
        await stream.aclose()
        assert [e["text"] for e in got] == ["old 2", "old 3", "live"]
        assert not c._subs
    asyncio.run(run())


def test_start_without_cef_does_not_block(monkeypatch):
    from decky_mcp import cdp

    async def unreachable():
        raise cdp.CdpError("Steam CEF debugger not reachable")

    monkeypatch.setattr(cdp, "list_targets", unreachable)

    async def run():
        c = ConsoleCollector(LOG)
        c.start()
        await asyncio.sleep(0.05)
        assert all(not st["connected"] and "not reachable" in st["error"] for st in c.status())
        await asyncio.wait_for(c.stop(), 1)
    asyncio.run(run())


TOKEN = "t"
H = {"Authorization": f"Bearer {TOKEN}"}


async def with_api(fn, console):
    api = Api(auth=TokenAuth(TOKEN), mcp=McpServer(build_registry(console=console), LOG), capturer=None,
              static_dir=None, logger=LOG, console=console)
    runner = web.AppRunner(api.build_app())
    await runner.setup()
    await web.TCPSite(runner, "127.0.0.1", 0).start()
    try:
        async with ClientSession(timeout=ClientTimeout(total=5)) as session:
            await fn(session, f"http://127.0.0.1:{runner.addresses[0][1]}")
    finally:
        await runner.cleanup()


def test_console_routes_and_tools():
    c = ConsoleCollector(LOG)
    c.handle_message("SharedJSContext", console_msg("warning", s("decky-mcp test")))

    async def run(session, base):
        async with session.get(f"{base}/cef/console", headers=H) as r:
            body = await r.json()
        assert [e["text"] for e in body["entries"]] == ["decky-mcp test"]
        async with session.get(f"{base}/cef/console?level=nope", headers=H) as r:
            assert r.status == 400
        async with session.get(f"{base}/cef/console/stream?target=bogus", headers=H) as r:
            assert r.status == 400
        async with session.get(f"{base}/cef/console") as r:
            assert r.status == 401

        async with session.get(f"{base}/cef/console/stream?tail=5", headers=H) as r:
            assert r.headers["Content-Type"].startswith("text/event-stream")
            first = await asyncio.wait_for(r.content.readline(), 2)
            assert json.loads(first.decode()[len("data: "):])["text"] == "decky-mcp test"
            await r.content.readline()
            c.handle_message("SharedJSContext", console_msg("error", s("live one"), ts=TS + 5))
            live = await asyncio.wait_for(r.content.readline(), 2)
            assert json.loads(live.decode()[len("data: "):])["text"] == "live one"
        for _ in range(40):  # the server notices the disconnect within ~1 s
            if not c._subs:
                break
            await asyncio.sleep(0.05)
        assert not c._subs

        rpc = {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
               "params": {"name": "cef_console", "arguments": {"level": "error"}}}
        async with session.post(f"{base}/mcp", json=rpc, headers=H) as r:
            result = (await r.json())["result"]
        assert [e["text"] for e in json.loads(result["content"][0]["text"])["entries"]] == ["live one"]
        rpc["params"] = {"name": "cef_console_clear", "arguments": {}}
        async with session.post(f"{base}/mcp", json=rpc, headers=H) as r:
            assert json.loads((await r.json())["result"]["content"][0]["text"])["cleared"]["SharedJSContext"] == 2

    asyncio.run(with_api(run, c))
