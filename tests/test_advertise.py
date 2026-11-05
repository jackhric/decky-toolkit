"""DNS-SD advertiser tests with a fake avahi-publish. Run with: ./scripts/test.sh"""
import asyncio
import logging
import stat
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "py_modules"))

from decky_toolkit.advertise import SERVICE_TYPE, Advertiser, instance_name, txt_records  # noqa: E402

LOG = logging.getLogger("t")


def fake_publisher(tmp_path: Path, body: str) -> str:
    script = tmp_path / "avahi-publish"
    script.write_text(f"#!/bin/sh\necho \"$@\" >> {tmp_path}/calls\n{body}\n")
    script.chmod(script.stat().st_mode | stat.S_IXUSR)
    return str(script)


async def wait_for(cond, timeout=3.0):
    loop = asyncio.get_running_loop()
    end = loop.time() + timeout
    while not cond():
        assert loop.time() < end, "timed out"
        await asyncio.sleep(0.02)


def test_names_and_txt():
    assert instance_name("bazzite.internal") == "bazzite"
    assert instance_name("steamdeck") == "steamdeck"
    assert txt_records("0.3.0", 1, "abcd") == ["api=1", "version=0.3.0", "id=abcd"]
    assert txt_records("0.3.0", 1, None) == ["api=1", "version=0.3.0"]


def test_publishes_until_stopped(tmp_path):
    async def run():
        ad = Advertiser(LOG, 8765, ["api=1", "id=abcd"], name="deck", binary=fake_publisher(tmp_path, "exec sleep 30"))
        ad.start()
        calls = tmp_path / "calls"
        await wait_for(calls.exists)
        assert calls.read_text().split() == ["-s", "deck", SERVICE_TYPE, "8765", "api=1", "id=abcd"]
        await wait_for(lambda: ad.proc is not None)
        pid = ad.proc.pid
        await ad.stop()
        assert ad.proc.returncode is not None
        assert not Path(f"/proc/{pid}").exists() or "zombie" in Path(f"/proc/{pid}/status").read_text()
    asyncio.run(run())


def test_restarts_after_exit(tmp_path):
    async def run():
        ad = Advertiser(LOG, 9000, [], name="deck", binary=fake_publisher(tmp_path, "echo collision >&2; exit 1"),
                        backoff=(0.01,))
        ad.start()
        calls = tmp_path / "calls"
        await wait_for(lambda: calls.exists() and len(calls.read_text().splitlines()) >= 3)
        await ad.stop()
    asyncio.run(run())


def test_missing_binary_is_quiet(tmp_path):
    async def run():
        ad = Advertiser(LOG, 8765, [], name="deck", binary=str(tmp_path / "nope"))
        ad.start()
        await asyncio.sleep(0.05)
        assert ad.task is not None and ad.task.done() and ad.proc is None
        await ad.stop()
    asyncio.run(run())


def test_child_dies_with_parent(tmp_path):
    # An orphaned backend is os._exit()ed by the loader watchdog; avahi-publish must not outlive it.
    pidfile = tmp_path / "child.pid"
    publisher = fake_publisher(tmp_path, f"echo $$ > {pidfile}; exec sleep 30")
    host = tmp_path / "host.py"
    host.write_text(
        "import asyncio, logging, sys\n"
        f"sys.path.insert(0, {str(Path(__file__).resolve().parents[1] / 'py_modules')!r})\n"
        "from decky_toolkit.advertise import Advertiser\n"
        "async def main():\n"
        f"    Advertiser(logging.getLogger(), 1, [], name='x', binary={publisher!r}).start()\n"
        "    await asyncio.sleep(30)\n"
        "asyncio.run(main())\n")

    async def run():
        parent = await asyncio.create_subprocess_exec(sys.executable, str(host))
        await wait_for(lambda: pidfile.exists() and pidfile.read_text().strip())
        child = int(pidfile.read_text())
        parent.kill()
        await parent.wait()
        await wait_for(lambda: not Path(f"/proc/{child}").exists())
    asyncio.run(run())
