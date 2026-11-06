"""Tool argument checks, the tool list fingerprint and backend diagnostics. Run with: ./scripts/test.sh"""
import asyncio
import logging
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "py_modules"))

from decky_toolkit import diagnostics  # noqa: E402
from decky_toolkit.tools import ToolRegistry, build_registry  # noqa: E402

LOG = logging.getLogger("t")


def registry() -> ToolRegistry:
    reg = ToolRegistry()

    @reg.add("nav", "Navigate.", {"properties": {"path": {"type": "string"}, "action": {"type": "string", "enum": ["back", "home"]}},
                                  "required": ["path"]})
    async def nav(path: str, action: str = "back") -> str:
        return f"{path} {action}"

    @reg.add("buggy", "Raises a TypeError of its own.")
    async def buggy() -> str:
        return "%c" % "too long"

    return reg


def text(result: dict) -> str:
    return result["content"][0]["text"]


def test_unknown_and_missing_arguments_list_the_schema():
    reg = registry()
    r = asyncio.run(reg.call("nav", {"target": "/x"}))
    assert r["isError"]
    assert text(r) == ("Invalid arguments for nav: unknown argument 'target'. "
                       "Arguments: path (string, required); action (back|home).")
    r = asyncio.run(reg.call("nav", {"action": "home"}))
    assert r["isError"] and "missing required 'path'" in text(r)
    assert asyncio.run(reg.call("nav", {"path": "/x"})) == {"content": [{"type": "text", "text": "/x back"}], "isError": False}


def test_a_typeerror_inside_a_tool_is_reported_as_a_bug():
    r = asyncio.run(registry().call("buggy", {}))
    assert r["isError"]
    assert text(r).startswith("TypeError: %c requires") and "Traceback" in text(r)
    assert "Invalid arguments" not in text(r)


def test_every_real_tool_signature_matches_its_schema():
    reg = build_registry()
    for t in reg._tools.values():
        import inspect
        params = {n for n, p in inspect.signature(t.fn).parameters.items() if p.kind is p.KEYWORD_ONLY or p.kind is p.POSITIONAL_OR_KEYWORD}
        assert set(t.input_schema.get("properties", {})) <= params, t.name


def test_fingerprint_follows_the_tool_list():
    a, b = registry(), registry()
    assert a.fingerprint() == b.fingerprint() and len(a.fingerprint()) == 16

    @b.add("extra", "One more.")
    async def extra() -> str:
        return ""

    assert a.fingerprint() != b.fingerprint()


def test_watchdog_logs_the_blocking_stack_and_recovery(caplog):
    def block_the_loop():
        time.sleep(0.8)

    async def run():
        wd = diagnostics.LoopWatchdog(asyncio.get_running_loop(), LOG, threshold=0.3, interval=0.05)
        wd.start()
        await asyncio.sleep(0.2)
        block_the_loop()
        await asyncio.sleep(0.3)
        wd.stop()
        return wd.stats()

    with caplog.at_level(logging.WARNING, logger="t"):
        stats = asyncio.run(run())
    assert len(stats["stalls"]) == 1
    stall = stats["stalls"][0]
    assert any("block_the_loop" in line for line in stall["stack"]), stall["stack"]
    assert stall["lasted_s"] and 0.5 < stall["lasted_s"] < 1.5
    assert stats["max_lag_ms"] > 500
    assert any("event loop blocked" in r.message for r in caplog.records)
    assert any("answered again" in r.message for r in caplog.records)


def test_snapshot_lists_threads_and_tasks():
    async def run():
        async def parked():
            await asyncio.Event().wait()

        t = asyncio.create_task(parked(), name="parked-task")
        await asyncio.sleep(0)
        snap = diagnostics.snapshot()
        t.cancel()
        return snap

    snap = asyncio.run(run())
    assert any(th["thread"] == "MainThread" for th in snap["threads"])
    task = next(t for t in snap["tasks"] if t["name"] == "parked-task")
    assert task["coro"].endswith("parked") and any("parked" in f for f in task["stack"])
