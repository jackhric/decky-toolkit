"""Self-update: version compare, manifest validation, check/apply, auto loop gating and /update routes. Run with: ./scripts/test.sh"""
import asyncio
import hashlib
import json
import logging
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "py_modules"))

from aiohttp import ClientSession, ClientTimeout, web  # noqa: E402

from decky_toolkit import update as upd  # noqa: E402
from decky_toolkit.auth import TokenAuth  # noqa: E402
from decky_toolkit.http import Api  # noqa: E402
from decky_toolkit.protocol import McpServer  # noqa: E402
from decky_toolkit.settings import Settings  # noqa: E402
from decky_toolkit.tools import ToolRegistry  # noqa: E402
from decky_toolkit.update import Updater, is_newer, parse_manifest, parse_version  # noqa: E402

LOG = logging.getLogger("t")
TOKEN = "test-token"
H = {"Authorization": f"Bearer {TOKEN}"}
ZIP = b"PK\x05\x06" + b"\0" * 18


def test_parse_version_and_ordering():
    assert parse_version("1.2.3") is not None
    assert parse_version("v1.2.3") == parse_version("1.2.3")
    assert parse_version("1.2") is None and parse_version("") is None and parse_version(None) is None
    assert is_newer("0.7.0", "0.6.4") and is_newer("1.0.0", "0.99.99") and is_newer("0.6.10", "0.6.9")
    assert not is_newer("0.6.4", "0.6.4") and not is_newer("0.6.3", "0.6.4")
    assert is_newer("1.0.0", "1.0.0-rc.1") and not is_newer("1.0.0-rc.1", "1.0.0")
    assert is_newer("1.0.0-rc.2", "1.0.0-rc.1") and is_newer("1.0.0-rc.1", "1.0.0-beta")
    assert not is_newer("garbage", "0.1.0") and not is_newer("0.2.0", "dev")


def manifest(version="0.7.0", data=ZIP, **extra):
    return {"plugin": {"version": version, "sha256": hashlib.sha256(data).hexdigest(), "size": len(data),
                       "url": "https://example.invalid/decky-toolkit.zip", "published_at": "2026-11-04T00:00:00Z", **extra}}


def test_parse_manifest_rejects_bad_fields():
    assert parse_manifest(manifest())["version"] == "0.7.0"
    for bad in ({}, {"plugin": []}, manifest(version="1.0"), manifest(sha256="abc"), manifest(size=0),
                manifest(size=upd.MAX_ZIP_BYTES + 1), manifest(size=True), manifest(url="http://x/y.zip")):
        with pytest.raises(ValueError):
            parse_manifest(bad)


class FakeSite:
    """Serves /update.json and /decky-toolkit.zip; `zip_bytes` can differ from the manifest to test the hash check."""

    def __init__(self, version="0.7.0"):
        self.manifest = manifest(version)
        self.zip_bytes = ZIP
        self.manifest_status = 200
        self.hits: list[str] = []

    async def __aenter__(self):
        app = web.Application()
        app.add_routes([web.get("/update.json", self._manifest), web.get("/decky-toolkit.zip", self._zip)])
        self.runner = web.AppRunner(app)
        await self.runner.setup()
        await web.TCPSite(self.runner, "127.0.0.1", 0).start()
        self.base = f"http://127.0.0.1:{self.runner.addresses[0][1]}"
        self.manifest["plugin"]["url"] = f"{self.base}/decky-toolkit.zip"
        return self

    async def __aexit__(self, *exc):
        await self.runner.cleanup()

    async def _manifest(self, _r):
        self.hits.append("manifest")
        return web.json_response(self.manifest, status=self.manifest_status)

    async def _zip(self, _r):
        self.hits.append("zip")
        return web.Response(body=self.zip_bytes, content_type="application/zip")


def make_updater(site: FakeSite, settings: Settings, current="0.6.4", busy=None, install=None, events=None):
    installs: list[tuple[bytes, str]] = []

    async def default_install(data, restart):
        installs.append((data, restart))
        return {"installed": {"version": "x"}, "restarted": restart}

    u = Updater(lambda: settings, lambda: None, LOG, current_version=current, install=install or default_install,
                busy=busy or (lambda: None), on_change=(events.append if events is not None else None),
                manifest_url=f"{site.base}/update.json")
    return u, installs


@pytest.fixture(autouse=True)
def allow_http_manifest(monkeypatch):
    # Tests serve the manifest and zip over plain http; the real parser insists on https.
    orig = upd.parse_manifest

    def lenient(data):
        if isinstance(data, dict) and isinstance(data.get("plugin"), dict):
            data = {"plugin": {**data["plugin"], "url": data["plugin"]["url"].replace("http://", "https://", 1)}}
            parsed = orig(data)
            parsed["url"] = parsed["url"].replace("https://", "http://", 1)
            return parsed
        return orig(data)

    monkeypatch.setattr(upd, "parse_manifest", lenient)


def test_check_reports_available_and_errors():
    async def main():
        async with FakeSite() as site:
            events = []
            u, _ = make_updater(site, Settings(), events=events)
            st = u.status()
            assert st["current"] == "0.6.4" and st["latest"] is None and not st["available"] and st["auto_update"]
            st = await u.check()
            assert st["available"] and st["latest"]["version"] == "0.7.0" and st["error"] is None and st["checked_at"]
            assert "sha256" not in st["latest"]
            assert [e["checking"] for e in events] == [True, False]

            site.manifest_status = 500
            st = await u.check()
            assert st["error"].startswith("update check failed") and st["available"]  # last good manifest is kept

            u2, _ = make_updater(site, Settings(), current="0.7.0")
            site.manifest_status = 200
            assert not (await u2.check())["available"]
    asyncio.run(main())


def test_apply_verifies_hash_and_installs():
    async def main():
        async with FakeSite() as site:
            u, installs = make_updater(site, Settings())
            site.zip_bytes = ZIP + b"tampered"
            with pytest.raises(ValueError, match="size|sha256"):
                await u.apply()
            assert installs == [] and u.applying is None and "failed" in u.status()["error"]

            site.zip_bytes = ZIP
            st = await u.apply()
            assert installs == [(ZIP, "loader")] and st["applying"] == "0.7.0" and st["error"] is None

            u3, installs3 = make_updater(site, Settings(), current="0.7.0")
            with pytest.raises(ValueError, match="up to date"):
                await u3.apply()
            assert installs3 == []
    asyncio.run(main())


def test_run_loop_defers_while_busy_and_honours_auto_update(monkeypatch):
    async def main():
        async with FakeSite() as site:
            monkeypatch.setattr(upd, "BUSY_RETRY", 0.05)
            monkeypatch.setattr(upd, "CHECK_INTERVAL", 0.05)
            busy = {"reason": "the screen stream has viewers"}
            settings = Settings(auto_update=False)
            u, installs = make_updater(site, settings, busy=lambda: busy["reason"])
            task = asyncio.create_task(u.run(first_delay=0))
            await asyncio.sleep(0.2)
            assert u.available and installs == []  # auto_update off: checked, not applied

            await u.set_auto_update(True)
            await asyncio.sleep(0.2)
            assert installs == []  # busy: deferred
            busy["reason"] = None
            for _ in range(40):
                await asyncio.sleep(0.05)
                if installs:
                    break
            assert installs == [(ZIP, "loader")]
            task.cancel()
    asyncio.run(main())


async def with_api(fn, updater):
    api = Api(auth=TokenAuth(TOKEN), mcp=McpServer(ToolRegistry(), LOG), capturer=None, static_dir=None, logger=LOG,
              updater=updater)
    runner = web.AppRunner(api.build_app())
    await runner.setup()
    await web.TCPSite(runner, "127.0.0.1", 0).start()
    base = f"http://127.0.0.1:{runner.addresses[0][1]}"
    try:
        async with ClientSession(timeout=ClientTimeout(total=10)) as s:
            await fn(s, base)
    finally:
        await runner.cleanup()


def test_update_routes():
    async def main():
        async with FakeSite() as site:
            settings = Settings()
            u, installs = make_updater(site, settings)

            async def fn(s, base):
                async with s.get(f"{base}/update", headers=H) as r:
                    assert r.status == 200 and (await r.json())["latest"] is None
                async with s.post(f"{base}/update/check") as r:
                    assert r.status == 401
                async with s.post(f"{base}/update/check", headers=H) as r:
                    assert r.status == 200 and (await r.json())["available"]
                async with s.put(f"{base}/update/settings", headers=H, json={"auto_update": "yes"}) as r:
                    assert r.status == 400
                async with s.put(f"{base}/update/settings", headers=H, json={"auto_update": False}) as r:
                    assert r.status == 200 and not (await r.json())["auto_update"] and settings.auto_update is False
                async with s.post(f"{base}/update/apply", headers=H) as r:
                    assert r.status == 200 and (await r.json())["applying"] == "0.7.0"
                assert installs == [(ZIP, "loader")]

            await with_api(fn, u)

            async def no_updater(s, base):
                async with s.get(f"{base}/update", headers=H) as r:
                    assert r.status == 404
                u2, _ = make_updater(site, Settings(), current="0.7.0")
                await u2.check()

            await with_api(no_updater, None)

            u3, _ = make_updater(site, Settings(), current="0.7.0")

            async def up_to_date(s, base):
                async with s.post(f"{base}/update/apply", headers=H) as r:
                    assert r.status == 409 and "up to date" in (await r.json())["error"]

            await with_api(up_to_date, u3)
    asyncio.run(main())
