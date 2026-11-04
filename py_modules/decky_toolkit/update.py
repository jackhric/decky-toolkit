"""Self-update: compare the running version with a published manifest and install a newer release."""
import asyncio
import hashlib
import logging
import re
import ssl
import time
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable

import aiohttp

MANIFEST_URL = "https://jackhric.github.io/decky-toolkit/update.json"
FIRST_CHECK_DELAY = 30.0
CHECK_INTERVAL = 6 * 3600.0
BUSY_RETRY = 10 * 60.0
MAX_ZIP_BYTES = 64 * 1024 * 1024

_SEMVER = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$")
Install = Callable[[bytes, str], Awaitable[dict[str, Any]]]


def parse_version(text: Any) -> tuple | None:
    m = _SEMVER.match(text.strip()) if isinstance(text, str) else None
    if not m:
        return None
    pre = m.group(4)
    # A pre-release sorts below its release; numeric identifiers sort below alphanumeric ones.
    idents = tuple((0, int(p), "") if p.isdigit() else (1, 0, p) for p in pre.split(".")) if pre else ()
    return (int(m[1]), int(m[2]), int(m[3]), 0 if pre is None else -1, idents)


def is_newer(candidate: Any, current: Any) -> bool:
    a, b = parse_version(candidate), parse_version(current)
    return a is not None and b is not None and a > b


def _ssl_context() -> ssl.SSLContext | bool:
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return True


def parse_manifest(data: Any) -> dict[str, Any]:
    plugin = data.get("plugin") if isinstance(data, dict) else None
    if not isinstance(plugin, dict):
        raise ValueError("manifest has no 'plugin' object")
    version, sha, url, size = plugin.get("version"), plugin.get("sha256"), plugin.get("url"), plugin.get("size")
    if parse_version(version) is None:
        raise ValueError(f"manifest version {version!r} is not semver")
    if not isinstance(sha, str) or not re.fullmatch(r"[0-9a-f]{64}", sha.lower()):
        raise ValueError("manifest sha256 is not a hex digest")
    if not isinstance(url, str) or not url.startswith("https://"):
        raise ValueError("manifest url must be https")
    if not isinstance(size, int) or isinstance(size, bool) or not 0 < size <= MAX_ZIP_BYTES:
        raise ValueError("manifest size is missing or out of range")
    return {"version": version, "sha256": sha.lower(), "url": url, "size": size,
            "published_at": plugin.get("published_at") if isinstance(plugin.get("published_at"), str) else None}


class Updater:
    def __init__(self, settings: Callable[[], Any], save: Callable[[], None], logger: logging.Logger, *,
                 current_version: str, install: Install, busy: Callable[[], str | None],
                 on_change: Callable[[dict[str, Any]], None] | None = None, manifest_url: str = MANIFEST_URL):
        self._settings = settings
        self._save = save
        self.log = logger
        self.current = current_version
        self._install = install
        self._busy = busy
        self._on_change = on_change
        self.manifest_url = manifest_url
        self.latest: dict[str, Any] | None = None
        self.checked_at: float | None = None
        self.error: str | None = None
        self.checking = False
        self.applying: str | None = None
        self._lock = asyncio.Lock()
        self._task: asyncio.Task | None = None
        self._wake = asyncio.Event()

    @property
    def available(self) -> bool:
        return self.latest is not None and is_newer(self.latest["version"], self.current)

    def status(self) -> dict[str, Any]:
        latest = None if self.latest is None else {k: self.latest[k] for k in ("version", "url", "size", "published_at")}
        checked = None if self.checked_at is None else datetime.fromtimestamp(self.checked_at, timezone.utc).isoformat()
        return {"current": self.current, "latest": latest, "available": self.available,
                "auto_update": bool(self._settings().auto_update), "checked_at": checked, "checking": self.checking,
                "applying": self.applying, "busy": self._busy(), "error": self.error}

    def _changed(self) -> None:
        if self._on_change is not None:
            self._on_change(self.status())

    async def set_auto_update(self, enabled: Any) -> dict[str, Any]:
        if not isinstance(enabled, bool):
            raise ValueError("auto_update must be true or false")
        s = self._settings()
        if s.auto_update != enabled:
            s.auto_update = enabled
            self._save()
            self._changed()
            self._wake.set()
        return self.status()

    async def check(self) -> dict[str, Any]:
        self.checking = True
        self._changed()
        try:
            timeout = aiohttp.ClientTimeout(total=30)
            async with aiohttp.ClientSession(timeout=timeout, headers=self._headers()) as session:
                async with session.get(self.manifest_url, ssl=_ssl_context()) as r:
                    if r.status != 200:
                        raise ValueError(f"manifest {self.manifest_url} returned HTTP {r.status}")
                    self.latest = parse_manifest(await r.json(content_type=None))
            self.error = None
            self.checked_at = time.time()
            if self.available:
                self.log.info("update available: %s -> %s", self.current, self.latest["version"])
        except (aiohttp.ClientError, asyncio.TimeoutError, ValueError) as e:
            self.error = f"update check failed: {e}"
            self.log.warning(self.error)
        finally:
            self.checking = False
            self._changed()
        return self.status()

    async def apply(self) -> dict[str, Any]:
        if self._lock.locked():
            raise ValueError("an update is already being applied")
        async with self._lock:
            if self.latest is None or self.checked_at is None or time.time() - self.checked_at > CHECK_INTERVAL:
                await self.check()
            if self.error and self.latest is None:
                raise ValueError(self.error)
            if not self.available:
                raise ValueError(f"already up to date ({self.current})")
            assert self.latest is not None
            target = self.latest
            self.applying = target["version"]
            self.error = None
            self._changed()
            try:
                data = await self._download(target)
                self.log.info("installing update %s (%d bytes)", target["version"], len(data))
                await self._install(data, "loader")
            except Exception as e:
                self.applying = None
                self.error = f"update to {target['version']} failed: {e}"
                self.log.warning(self.error)
                self._changed()
                raise
            # The loader restart that follows kills this process; `applying` stays set until then.
            self._changed()
            return self.status()

    async def _download(self, target: dict[str, Any]) -> bytes:
        timeout = aiohttp.ClientTimeout(total=600, sock_read=60)
        digest = hashlib.sha256()
        chunks: list[bytes] = []
        total = 0
        async with aiohttp.ClientSession(timeout=timeout, headers=self._headers()) as session:
            async with session.get(target["url"], ssl=_ssl_context()) as r:
                if r.status != 200:
                    raise ValueError(f"{target['url']} returned HTTP {r.status}")
                async for chunk in r.content.iter_chunked(256 * 1024):
                    total += len(chunk)
                    if total > target["size"]:
                        raise ValueError(f"download exceeds the manifest size of {target['size']} bytes")
                    digest.update(chunk)
                    chunks.append(chunk)
        if total != target["size"]:
            raise ValueError(f"downloaded {total} bytes, manifest says {target['size']}")
        if digest.hexdigest() != target["sha256"]:
            raise ValueError("sha256 mismatch")
        return b"".join(chunks)

    def _headers(self) -> dict[str, str]:
        return {"User-Agent": f"decky-toolkit/{self.current}", "Accept": "application/json, application/zip, */*"}

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self.run(), name="toolkit-updater")

    def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            self._task = None

    async def run(self, first_delay: float = FIRST_CHECK_DELAY) -> None:
        delay = first_delay
        while True:
            await self._sleep(delay)
            delay = CHECK_INTERVAL
            if self.applying:
                continue
            await self.check()
            if not (self.available and self._settings().auto_update):
                continue
            if (reason := self._busy()) is not None:
                self.log.info("update %s available; deferring while %s", self.latest["version"], reason)  # type: ignore[index]
                delay = BUSY_RETRY
                continue
            try:
                await self.apply()
            except Exception:
                pass

    async def _sleep(self, seconds: float) -> None:
        self._wake.clear()
        try:
            await asyncio.wait_for(self._wake.wait(), seconds)
        except asyncio.TimeoutError:
            pass
