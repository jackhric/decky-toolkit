"""REST routes: /pair, /logs, /plugins. Run with: ./scripts/test.sh"""
import asyncio
import io
import json
import logging
import os
import sys
import time
import zipfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "py_modules"))

from aiohttp import ClientSession, ClientTimeout, FormData, web  # noqa: E402

from decky_mcp.auth import TOKEN_COOKIE, TokenAuth  # noqa: E402
from decky_mcp.http import Api  # noqa: E402
from decky_mcp.protocol import McpServer  # noqa: E402
from decky_mcp.tools import ToolRegistry  # noqa: E402

TOKEN = "test-token"
H = {"Authorization": f"Bearer {TOKEN}"}
LOG = logging.getLogger("t")


@pytest.fixture
def decky_home(tmp_path, monkeypatch):
    monkeypatch.setenv("DECKY_HOME", str(tmp_path))
    (tmp_path / "plugins").mkdir()
    return tmp_path


class State:
    pairing = False
    paired: list[str] = []


async def with_server(fn, **api_kwargs):
    State.paired = []

    async def on_paired(remote: str) -> None:
        State.paired.append(remote)

    api = Api(auth=TokenAuth(TOKEN), mcp=McpServer(ToolRegistry(), LOG), capturer=None, static_dir=None, logger=LOG,
              pairing_open=lambda: State.pairing, on_paired=on_paired, base_url=lambda: "http://10.1.2.3:8765",
              **api_kwargs)
    runner = web.AppRunner(api.build_app())
    await runner.setup()
    await web.TCPSite(runner, "127.0.0.1", 0).start()
    base = f"http://127.0.0.1:{runner.addresses[0][1]}"
    try:
        async with ClientSession(timeout=ClientTimeout(total=10)) as s:
            await fn(s, base)
    finally:
        await runner.cleanup()


def write_log(home: Path, plugin: str, name: str, lines: list[str], mtime: float | None = None) -> Path:
    d = home / "logs" / plugin
    d.mkdir(parents=True, exist_ok=True)
    p = d / name
    p.write_text("".join(f"{l}\n" for l in lines))
    if mtime is not None:
        os.utime(p, (mtime, mtime))
    return p


def test_pair_open_and_closed():
    async def run(s, base):
        State.pairing = False
        async with s.get(f"{base}/pair") as r:
            assert r.status == 403 and await r.json() == {"error": "pairing closed"}
        State.pairing = True
        async with s.get(f"{base}/pair", headers={"Origin": "http://evil.example"}) as r:
            assert r.status == 403
        async with s.get(f"{base}/pair") as r:
            assert r.status == 200
            assert await r.json() == {"token": TOKEN, "url": "http://10.1.2.3:8765", "api_version": 1}
        assert State.paired == ["127.0.0.1"]
        State.pairing = False
        async with s.get(f"{base}/pair") as r:
            assert r.status == 403
        assert len(State.paired) == 1
    asyncio.run(with_server(run))


def test_logs_tail_plugin(decky_home):
    now = time.time()
    write_log(decky_home, "foo", "old.log", ["stale"], mtime=now - 100)
    write_log(decky_home, "foo", "new.log", [f"line {i}" for i in range(10)], mtime=now)

    async def run(s, base):
        async with s.get(f"{base}/logs/tail?source=plugin&plugin=foo&tail=3") as r:
            assert r.status == 401
        async with s.get(f"{base}/logs/tail?source=plugin&plugin=foo&tail=3", headers=H) as r:
            assert await r.json() == {"lines": ["line 7", "line 8", "line 9"]}
        async with s.get(f"{base}/logs/tail?plugin=foo&tail=1", headers=H) as r:
            assert await r.json() == {"lines": ["line 9"]}
        async with s.get(f"{base}/logs/tail?source=plugin&plugin=nope", headers=H) as r:
            assert r.status == 404
        async with s.get(f"{base}/logs/tail?source=plugin&plugin=../etc", headers=H) as r:
            assert r.status == 400
        async with s.get(f"{base}/logs/tail?source=plugin", headers=H) as r:
            assert r.status == 400
        async with s.get(f"{base}/logs/tail?source=bogus", headers=H) as r:
            assert r.status == 400
    asyncio.run(with_server(run))


def test_logs_stream_plugin(decky_home):
    path = write_log(decky_home, "foo", "a.log", ["one", "two", "three"], mtime=time.time() - 10)

    async def run(s, base):
        async with s.get(f"{base}/logs/stream?plugin=foo&tail=2", headers=H) as r:
            assert r.status == 200
            assert r.headers["Content-Type"].startswith("text/event-stream")
            assert r.headers["Cache-Control"] == "no-store" and r.headers["X-Accel-Buffering"] == "no"
            seen: list[str] = []

            async def read_until(pred):
                while not pred():
                    seen.append((await asyncio.wait_for(r.content.readline(), 5)).decode().rstrip("\n"))

            await read_until(lambda: ": keepalive" in seen)
            assert [l for l in seen if l.startswith("data:")] == ["data: two", "data: three"]
            with open(path, "a") as f:
                f.write("four\npart")
            await read_until(lambda: "data: four" in seen)
            # Decky opens a new file per plugin start; the follower switches to it.
            write_log(decky_home, "foo", "b.log", ["fresh"])
            await read_until(lambda: "data: fresh" in seen)
            assert "data: part" in seen
    asyncio.run(with_server(run, log_keepalive=0.2))


def test_logs_stream_stops_follower_on_disconnect(monkeypatch):
    from decky_mcp import logs

    closed = asyncio.Event()

    async def fake_follow(source, plugin, n):
        try:
            yield "hello"
            await asyncio.sleep(3600)
        finally:
            closed.set()

    monkeypatch.setattr(logs, "follow", fake_follow)

    async def run(s, base):
        async with s.get(f"{base}/logs/stream", headers=H) as r:
            assert (await r.content.readline()) == b"data: hello\n"
        await asyncio.wait_for(closed.wait(), 3)
    asyncio.run(with_server(run, log_keepalive=60))


def test_plugins_install_list_and_bearer_only(decky_home):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("thing/plugin.json", json.dumps({"name": "Thing", "author": "a", "flags": [], "api_version": 1}))
        zf.writestr("thing/package.json", json.dumps({"version": "0.1.0"}))
        zf.writestr("thing/main.py", "")

    def form():
        f = FormData()
        f.add_field("file", buf.getvalue(), filename="thing.zip", content_type="application/zip")
        return f

    async def run(s, base):
        async with s.post(f"{base}/plugins/install?restart=none", data=form(), cookies={TOKEN_COOKIE: TOKEN}) as r:
            assert r.status == 401
        async with s.post(f"{base}/plugins/install?restart=bogus", data=form(), headers=H) as r:
            assert r.status == 400
        async with s.post(f"{base}/plugins/install?restart=none", data=form(), headers=H) as r:
            assert r.status == 200, await r.text()
            assert await r.json() == {"installed": {"dir": "thing", "name": "Thing", "version": "0.1.0"}, "restarted": "none"}
        async with s.get(f"{base}/plugins", headers=H) as r:
            listed = await r.json()
            assert [(p["dir"], p["name"], p["version"]) for p in listed] == [("thing", "Thing", "0.1.0")]
        bad = FormData()
        bad.add_field("file", b"not a zip", filename="x.zip")
        async with s.post(f"{base}/plugins/install?restart=none", data=bad, headers=H) as r:
            assert r.status == 400 and "zip" in (await r.json())["error"]
        async with s.post(f"{base}/plugins/missing/reload", headers=H) as r:
            assert r.status == 404
    asyncio.run(with_server(run))
