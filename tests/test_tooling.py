"""Tool argument checks, the tool list fingerprint and backend diagnostics. Run with: ./scripts/test.sh"""
import asyncio
import json
import logging
import os
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


# ---- run_command ----

from decky_toolkit import shell  # noqa: E402


def run(coro):
    return asyncio.run(coro)


def test_run_command_basics():
    r = run(shell.run_command("echo out; echo err >&2; exit 3", logger=LOG))
    assert (r["exit_code"], r["stdout"], r["stderr"], r["timed_out"]) == (3, "out\n", "err\n", False)
    assert r["user"] == shell.desktop_user().pw_name and r["cwd"] == shell.desktop_user().pw_dir
    assert run(shell.run_command("cat; pwd", cwd="/tmp", stdin="fed\n", logger=LOG))["stdout"] == "fed\n/tmp\n"
    env = run(shell.run_command("echo $XDG_RUNTIME_DIR $DISPLAY $LD_LIBRARY_PATH", logger=LOG))["stdout"].split()
    assert env == [f"/run/user/{shell.desktop_user().pw_uid}", ":0"]


def test_run_command_timeout_stops_the_whole_group():
    t = time.monotonic()
    r = run(shell.run_command("sleep 30 & sleep 30; echo never", timeout=0.3, logger=LOG))
    assert r["timed_out"] and r["stdout"] == "" and time.monotonic() - t < 4


def test_run_command_does_not_wait_for_background_children():
    t = time.monotonic()
    r = run(shell.run_command("sleep 30 & echo $!", logger=LOG))
    pid = int(r["stdout"])
    # Whether the child still holds the pipes (and "background" is set) depends on the runner; that it keeps
    # running and the call returns anyway does not.
    assert r["exit_code"] == 0 and time.monotonic() - t < 4
    os.kill(pid, 0)  # still running
    os.kill(pid, 15)


def test_run_command_truncates_and_checks_input():
    r = run(shell.run_command("head -c 5000 /dev/zero | tr '\\0' x", max_output=1024, logger=LOG))
    assert len(r["stdout"]) == 1024 and r["truncated"] == {"stdout_bytes": 5000, "stderr_bytes": 0, "kept": 1024}
    import pytest
    with pytest.raises(ValueError):
        run(shell.run_command("  ", logger=LOG))
    with pytest.raises(FileNotFoundError):
        run(shell.run_command("true", cwd="/nonexistent", logger=LOG))
    if os.geteuid() != 0:
        with pytest.raises(PermissionError):
            run(shell.run_command("true", root=True, logger=LOG))


def test_run_command_is_audited_in_full(caplog):
    with caplog.at_level(logging.INFO, logger="t"):
        run(shell.run_command("echo secret-free", logger=LOG))
    line = next(r.message for r in caplog.records if "run_command" in r.message)
    assert line.startswith("audit run_command as=") and line.endswith(": echo secret-free")


def test_exec_route():
    from aiohttp import ClientSession, web
    from certauth import H, stub_auth
    from decky_toolkit.server.http import Api
    from decky_toolkit.server.protocol import McpServer

    async def go():
        api = Api(auth=stub_auth(), mcp=McpServer(ToolRegistry(), LOG), capturer=None, logger=LOG)
        runner = web.AppRunner(api.build_app())
        await runner.setup()
        await web.TCPSite(runner, "127.0.0.1", 0).start()
        base = f"http://127.0.0.1:{runner.addresses[0][1]}"
        try:
            async with ClientSession() as s:
                async with s.post(f"{base}/exec", json={"command": "echo hi"}, headers=H) as r:
                    assert r.status == 200 and (await r.json())["stdout"] == "hi\n"
                async with s.post(f"{base}/exec", json={"command": "echo hi", "shell": "zsh"}, headers=H) as r:
                    assert r.status == 400
                async with s.post(f"{base}/exec", data=b"nope", headers=H) as r:
                    assert r.status == 400
                async with s.post(f"{base}/exec", json={"command": "echo hi"}) as r:
                    assert r.status == 401
        finally:
            await runner.cleanup()

    run(go())


# ---- physical input activity ----

from decky_toolkit.input import activity  # noqa: E402


def fake_device(sys_input: Path, event: str, name: str, ev: str, props: str = "0", virtual: bool = False) -> None:
    real = sys_input.parent / ("devices/virtual" if virtual else "devices/pci") / event
    (real / "capabilities").mkdir(parents=True)
    (real / "id").mkdir()
    (real / "name").write_text(name + "\n")
    (real / "capabilities" / "ev").write_text(ev + "\n")
    (real / "properties").write_text(props + "\n")
    (real / "id" / "vendor").write_text("28de\n")
    (real / "id" / "product").write_text("1205\n")
    (sys_input / event).mkdir(parents=True)
    (sys_input / event / "device").symlink_to(real)


def test_activity_filter(tmp_path):
    sys_input = tmp_path / "class" / "input"
    fake_device(sys_input, "event0", "Steam Deck", "1b")
    fake_device(sys_input, "event1", "Steam Deck Motion Sensors", "b", props="40")
    fake_device(sys_input, "event2", "HD-Audio Jack", "21")
    fake_device(sys_input, "event3", "Microsoft X-Box 360 pad 0", "20000b", virtual=True)
    got = {e: activity.describe(e, str(sys_input)) for e in ("event0", "event1", "event2", "event3")}
    assert got == {"event0": {"name": "Steam Deck", "id": "28de:1205"}, "event1": None, "event2": None, "event3": None}


def test_activity_records_time_and_device(tmp_path):
    sys_input, dev = tmp_path / "class" / "input", tmp_path / "dev"
    dev.mkdir()
    fake_device(sys_input, "event5", "USB Keyboard", "120013")
    os.mkfifo(dev / "event5")

    async def go():
        mon = activity.InputActivity(LOG, str(dev), str(sys_input))
        mon.scan()
        assert mon.snapshot()["last"] is None
        writer = os.open(dev / "event5", os.O_WRONLY | os.O_NONBLOCK)
        os.write(writer, b"\0" * 24)
        await asyncio.sleep(0.05)
        snap = mon.snapshot()
        os.close(writer)
        await mon.stop()
        return snap

    snap = run(go())
    assert snap["last"]["device"] == "USB Keyboard" and snap["last"]["seconds_ago"] < 1
    assert snap["devices"][0]["event"] == "event5"


def test_device_activity_tool():
    from decky_toolkit.tools import activity as activity_tools

    class Mon:
        def snapshot(self):
            return {"devices": [], "last": {"device": "Steam Deck", "at": time.time() - 5, "seconds_ago": 5.0}}

    class Svc:
        last_remote = {"at": time.time() - 120, "client": "10.0.0.30", "kind": "ws"}

    class Nav:
        async def state(self):
            return {"current": "/library/home", "side_menu": "none", "running_app": {"appid": 1, "name": "Game"}}

    reg = ToolRegistry()
    activity_tools.register(reg, Mon(), Svc(), None, Nav())
    out = json.loads(text(run(reg.call("device_activity", {}))))
    assert out["someone_at_device"] is True and out["remote_input_active"] is False
    assert out["remote"]["client"] == "10.0.0.30" and 119 < out["remote"]["seconds_ago"] < 125
    assert out["foreground"]["running_app"]["name"] == "Game"
    assert json.loads(text(run(reg.call("device_activity", {"active_within": 1}))))["someone_at_device"] is False


# ---- logs ----

from decky_toolkit.loader import logs  # noqa: E402


def test_wait_for_log_and_previous_runs(tmp_path, monkeypatch):
    monkeypatch.setenv("DECKY_HOME", str(tmp_path))
    d = tmp_path / "logs" / "demo"
    d.mkdir(parents=True)
    old, new = d / "2026-11-06 01.00.00.log", d / "2026-11-06 02.00.00.log"
    stamp = time.strftime("%Y-%m-%d %H:%M:%S")
    old.write_text("[2026-11-06 01:00:00,000][INFO]: Goodnight World!\n")
    os.utime(old, (time.time() - 60, time.time() - 60))
    new.write_text(f"[{stamp},000][INFO]: Hello World!\n")

    async def go():
        async def later():
            await asyncio.sleep(0.4)
            with open(new, "a") as f:
                f.write(f"[{stamp},500][INFO]: ready on port 1\n")
        asyncio.create_task(later())
        hit = await logs.wait_for("plugin", "demo", r"ready on port \d", 5)
        recent = await logs.wait_for("plugin", "demo", "hello world", 1, since_s=30)
        miss = await logs.wait_for("plugin", "demo", "never", 0.3)
        return hit, recent, miss

    hit, recent, miss = run(go())
    assert hit["matched"] and hit["lines"][0].endswith("ready on port 1") and hit["waited_ms"] >= 300
    assert recent["matched"] and "Hello World" in recent["lines"][0]
    assert miss == {"matched": False, "lines": [], "waited_ms": miss["waited_ms"]}

    reg = ToolRegistry()
    from decky_toolkit.tools import system
    system.register(reg)
    prev = json.loads(text(run(reg.call("read_plugin_log", {"plugin_dir": "demo", "run": 1}))))
    assert prev["file"] == old.name and "Goodnight" in prev["text"]
    only = json.loads(text(run(reg.call("read_plugin_log", {"plugin_dir": "demo", "match": "^\\[.*ready"}))))
    assert only["text"].endswith("ready on port 1")
    assert run(reg.call("read_plugin_log", {"plugin_dir": "demo", "run": 5}))["isError"]
