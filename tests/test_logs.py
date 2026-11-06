"""loader/logs.py: journal commands, plugin log files, grep/match filters and wait_for, with a fake journalctl and
real files. Run with: ./scripts/test.sh"""
import asyncio
import os
import time

import pytest

from certauth import H
from decky_toolkit.loader import logs
from harness import make_registry, with_server


class FakeJournal:
    """Stands in for journalctl: `run` for one-shot reads, `create_subprocess_exec` for -f."""

    def __init__(self, lines: list[str], code: int = 0, live: list[str] | None = None):
        self.lines, self.code, self.live = lines, code, live or []
        self.argv: list[tuple[str, ...]] = []

    async def run(self, *argv: str, timeout: float = 20):
        self.argv.append(argv)
        n = int(argv[argv.index("-n") + 1]) if "-n" in argv else len(self.lines)
        return self.code, "\n".join(self.lines[-n:] if n else []) + "\n"

    async def spawn(self, *argv, **_kwargs):
        self.argv.append(argv)
        journal = self

        class Stdout:
            async def readline(self):
                if journal.live:
                    await asyncio.sleep(0.01)
                    return (journal.live.pop(0) + "\n").encode()
                await asyncio.sleep(3600)

        class Proc:
            stdout, returncode = Stdout(), None

            def kill(self):
                self.returncode = -9

            async def wait(self):
                return self.returncode

        return Proc()


@pytest.fixture
def journal(monkeypatch):
    j = FakeJournal([f"line {i}" for i in range(3000)] + ["Loaded Demo", "stopped in 0.1s"])
    monkeypatch.setattr(logs, "run", j.run)
    monkeypatch.setattr(logs.asyncio, "create_subprocess_exec", j.spawn)
    return j


@pytest.fixture
def plugin_logs(tmp_path, monkeypatch):
    monkeypatch.setenv("DECKY_HOME", str(tmp_path))
    d = tmp_path / "logs" / "demo"
    d.mkdir(parents=True)
    (tmp_path / "plugins" / "demo").mkdir(parents=True)
    (tmp_path / "plugins" / "demo" / "plugin.json").write_text('{"name": "Demo Plugin"}')
    old, new = d / "2026-11-06 01.00.00.log", d / "2026-11-06 02.00.00.log"
    old.write_text("[2026-11-06 01:00:00,000][INFO]: Goodnight World!\n")
    os.utime(old, (time.time() - 60, time.time() - 60))
    stamp = time.strftime("%Y-%m-%d %H:%M:%S")
    new.write_text("".join(f"[{stamp},000][INFO]: line {i}\n" for i in range(50)) + f"[{stamp},500][INFO]: Hello World!\n")
    return {"dir": d, "old": old, "new": new, "stamp": stamp}


def test_journal_argv():
    base = ["journalctl", "-u", "plugin_loader", "--no-pager", "-o", "short-iso"]
    assert logs.journal_argv(5) == [*base, "-n", "5"]
    assert logs.journal_argv(5, since="-2min", until="today") == [*base, "--since=-2min", "--until=today"]
    assert logs.journal_argv(0, since="now", follow=True) == [*base, "--since=now", "-f"]


def test_filter_lines():
    lines = ["Loaded Demo", "Unloaded Demo", "SIGKILL sent", "nothing"]
    assert logs.filter_lines(lines, grep="LOADED") == ["Loaded Demo", "Unloaded Demo"]
    assert logs.filter_lines(lines, match=r"^loaded|sigkill") == ["Loaded Demo", "SIGKILL sent"]
    assert logs.filter_lines(lines, grep="demo", match=r"\bLoaded") == ["Loaded Demo"]
    assert logs.filter_lines(lines) == lines
    with pytest.raises(ValueError, match="match is not a valid regex"):
        logs.filter_lines(lines, match="(")


def test_read_journal(journal):
    async def go():
        assert await logs.read_journal(2) == ["Loaded Demo", "stopped in 0.1s"]
        assert journal.argv[-1][-2:] == ("-n", "2")
        # Filtered reads look further back than the lines they return.
        assert await logs.read_journal(1, grep="line 2999") == ["line 2999"]
        assert journal.argv[-1][-2:] == ("-n", str(logs.JOURNAL_SCAN))
        assert await logs.read_journal(3, match=r"^line 29\d\d$") == ["line 2997", "line 2998", "line 2999"]
        await logs.read_journal(10, since="-1h", until="now")
        assert journal.argv[-1][-2:] == ("--since=-1h", "--until=now")
        assert await logs.read_journal(0) == []
        journal.code = 1
        with pytest.raises(ValueError):
            await logs.read_journal(5, since="yesterdayish")
        with pytest.raises(RuntimeError):
            await logs.read_journal(5)
    asyncio.run(go())


def test_read_plugin(plugin_logs):
    out = logs.read_plugin("demo", 2)
    assert out["file"] == plugin_logs["new"].name and out["files"] == [plugin_logs["new"].name, plugin_logs["old"].name]
    assert out["lines"][-1].endswith("Hello World!") and len(out["lines"]) == 2
    assert logs.read_plugin("demo", 5, run_index=1)["lines"] == ["[2026-11-06 01:00:00,000][INFO]: Goodnight World!"]
    assert logs.read_plugin("demo", 5, file=plugin_logs["old"].name)["file"] == plugin_logs["old"].name
    assert [l.rsplit(": ", 1)[1] for l in logs.read_plugin("demo", 2, match=r"line \d$")["lines"]] == ["line 8", "line 9"]
    assert logs.read_plugin("demo", 100, grep="hello")["lines"] == [f"[{plugin_logs['stamp']},500][INFO]: Hello World!"]
    assert logs.read_plugin("demo", 0)["lines"] == []
    with pytest.raises(ValueError, match="run must be 0-1"):
        logs.read_plugin("demo", 5, run_index=2)
    with pytest.raises(FileNotFoundError):
        logs.read_plugin("demo", 5, file="nope.log")
    with pytest.raises(FileNotFoundError, match="no log dir"):
        logs.read_plugin("other", 5)
    with pytest.raises(ValueError):
        logs.read_plugin("../etc", 5)


def test_wait_for_plugin_match_since_and_timeout(plugin_logs):
    async def go():
        async def later():
            await asyncio.sleep(0.4)
            with open(plugin_logs["new"], "a") as f:
                f.write(f"[{plugin_logs['stamp']},900][INFO]: ready on port 1\n")
        asyncio.create_task(later())
        hit = await logs.wait_for("plugin", r"ready on port \d", 5, plugin="demo")
        recent = await logs.wait_for("plugin", "hello world", 1, since_s=30, plugin="demo")
        two = await logs.wait_for("plugin", r"line \d+$", 1, count=2, since_s=30, plugin="demo")
        miss = await logs.wait_for("plugin", "never", 0.3, plugin="demo")
        return hit, recent, two, miss

    hit, recent, two, miss = asyncio.run(go())
    assert hit["matched"] and hit["matches"][0].endswith("ready on port 1") and hit["waited_ms"] >= 300
    assert recent["matched"] and "Hello World" in recent["matches"][0]
    assert two["matched"] and [m[-6:] for m in two["matches"]] == ["line 0", "line 1"]
    assert miss == {"matched": False, "matches": [], "waited_ms": miss["waited_ms"]} and miss["waited_ms"] >= 300
    with pytest.raises(ValueError, match="pattern is not a valid regex"):
        asyncio.run(logs.wait_for("plugin", "(", 1, plugin="demo"))
    with pytest.raises(ValueError, match="source must be one of"):
        asyncio.run(logs.wait_for("proton", "x", 1))


def test_wait_for_journal_follows_from_now(journal):
    journal.live = ["Unloaded Demo", "Loaded Demo (v1)"]
    res = asyncio.run(logs.wait_for("loader", r"\bLoaded Demo", 2))
    assert res["matched"] and res["matches"] == ["Loaded Demo (v1)"]
    assert journal.argv[-1][-2:] == ("--since=now", "-f")
    res = asyncio.run(logs.wait_for("loader", "never", 0.2, since_s=12))
    assert not res["matched"] and journal.argv[-1][-2:] == ("--since=-12s", "-f")


def test_route_and_tool_read_the_same_lines(plugin_logs, journal):
    reg = make_registry()

    async def run(s, base):
        async with s.get(f"{base}/api/v1/logs/tail?plugin=demo&tail=3", headers=H) as r:
            route = (await r.json())["lines"]
        res = await reg.call("logs_read", {"source": "plugin", "plugin": "demo", "lines": 3})
        assert not res["isError"] and route == logs.read_plugin("demo", 3)["lines"]
        assert res["content"][0]["text"].count(route[-1]) == 1
        async with s.get(f"{base}/api/v1/logs/tail?tail=2", headers=H) as r:
            assert (await r.json())["lines"] == ["Loaded Demo", "stopped in 0.1s"]
        async with s.get(f"{base}/api/v1/logs/tail?plugin=nope", headers=H) as r:
            assert r.status == 404
    asyncio.run(with_server(run))
