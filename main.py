import asyncio
import os
import secrets
import socket
import sys
import threading
import time
from typing import Any

import decky
from aiohttp import web

sys.path.append(decky.DECKY_PLUGIN_DIR + "/py_modules")  # the loader does this too; kept for IDE/type tooling parity

from decky_mcp.auth import TokenAuth  # noqa: E402
from decky_mcp.capture import ScreenCapturer  # noqa: E402
from decky_mcp.http import Api  # noqa: E402
from decky_mcp.protocol import McpServer  # noqa: E402
from decky_mcp.settings import Settings  # noqa: E402
from decky_mcp.tools import build_registry  # noqa: E402


def _primary_ip() -> str:
    # UDP connect sends no packets; it just asks the kernel which source address it would pick.
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))
            return s.getsockname()[0]
    except OSError:
        return socket.gethostname()


def _proc_start(pid: int) -> str | None:
    try:
        with open(f"/proc/{pid}/stat") as f:
            # Field 22 (starttime) distinguishes a reused PID from the original process.
            return f.read().rsplit(")", 1)[1].split()[19]
    except OSError:
        return None


def _find_loader_pid() -> int:
    # Under Python 3.14 multiprocessing defaults to forkserver, so our parent is the forkserver
    # helper and the loader is our grandparent. Under fork, the parent is the loader itself.
    pid = os.getppid()
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as f:
            if b"multiprocessing.forkserver" in f.read():
                with open(f"/proc/{pid}/stat") as st:
                    pid = int(st.read().rsplit(")", 1)[1].split()[1])
    except OSError:
        pass
    return pid


def _loader_watchdog() -> None:
    # When the loader dies it does not reap plugin processes (decky-loader #975/#983). The orphan's
    # socket reader then spins on EOF, leaking memory until the OOM killer steps in (observed: 6 GB),
    # and meanwhile holds our port. A thread, not a task, so a starved event loop cannot delay it.
    loader_pid = _find_loader_pid()
    started = _proc_start(loader_pid)
    while os.getppid() != 1 and _proc_start(loader_pid) == started:
        time.sleep(1)
    decky.logger.warning("Loader pid %s is gone; exiting orphaned MCP server", loader_pid)
    os._exit(0)


PAIRING_SECONDS = 120


class Plugin:
    settings: Settings
    runner: web.AppRunner | None = None
    capturer: ScreenCapturer | None = None
    last_error: str | None = None
    pairing_until: float = 0.0
    pairing_count: int = 0

    async def _start_server(self) -> None:
        await self._stop_server()
        if not self.settings.enabled:
            return
        if self.capturer is None:
            self.capturer = ScreenCapturer(lambda: self.settings, decky.logger)
        api = Api(
            auth=TokenAuth(self.settings.token),
            mcp=McpServer(build_registry(self.capturer), decky.logger),
            capturer=self.capturer,
            static_dir=os.path.join(decky.DECKY_PLUGIN_DIR, "static"),
            logger=decky.logger,
            pairing_open=self._pairing_open,
            on_paired=self._on_paired,
            base_url=self._base_url,
        )
        # The loader SIGKILLs a plugin 5s after SIGTERM, so never wait long for in-flight requests.
        runner = web.AppRunner(api.build_app(), access_log=None, shutdown_timeout=2)
        await runner.setup()
        # A previous instance may still be releasing the port (loader restart races, orphaned
        # backends on their way out), so retry for a while before giving up.
        for attempt in range(15):
            try:
                await web.TCPSite(runner, self.settings.bind, self.settings.port, reuse_address=True).start()
                break
            except OSError as e:
                self.last_error = f"bind {self.settings.bind}:{self.settings.port} failed: {e}"
                if attempt == 0:
                    decky.logger.warning("%s; retrying", self.last_error)
                await asyncio.sleep(1)
        else:
            await runner.cleanup()
            decky.logger.error(self.last_error)
            return
        self.runner = runner
        self.last_error = None
        decky.logger.info("MCP server listening on http://%s:%s/mcp", self.settings.bind, self.settings.port)

    async def _stop_server(self) -> None:
        if self.capturer is not None:
            await self.capturer.stop()
        if self.runner is not None:
            await self.runner.cleanup()
            self.runner = None

    def _base_url(self, ip: str | None = None) -> str:
        return f"http://{ip or _primary_ip()}:{self.settings.port}"

    # ---- pairing ----

    def _pairing_open(self) -> bool:
        return time.monotonic() < self.pairing_until

    def _pairing_seconds_left(self) -> int:
        return max(0, int(self.pairing_until - time.monotonic() + 0.999))

    async def _on_paired(self, remote: str) -> None:
        self.pairing_count += 1
        decky.logger.info("browser paired from %s", remote)
        await decky.emit("decky_mcp_paired", remote)

    async def start_pairing(self) -> dict[str, Any]:
        self.pairing_until = time.monotonic() + PAIRING_SECONDS
        self.pairing_count = 0
        decky.logger.info("pairing window open for %ss", PAIRING_SECONDS)
        return await self.get_status()

    async def stop_pairing(self) -> dict[str, Any]:
        self.pairing_until = 0.0
        return await self.get_status()

    # ---- methods callable from the frontend ----

    async def get_status(self) -> dict[str, Any]:
        ip = _primary_ip()
        base = self._base_url(ip)
        return {
            "enabled": self.settings.enabled,
            "running": self.runner is not None,
            "bind": self.settings.bind,
            "port": self.settings.port,
            "token": self.settings.token,
            "ip": ip,
            "url": f"{base}/mcp",
            "viewer_url": f"{base}/viewer?token={self.settings.token}",
            "pair_url": f"{base}/viewer",
            "pairing_seconds_left": self._pairing_seconds_left(),
            "pairing_count": self.pairing_count,
            "stream": self.capturer.stats() if self.capturer else None,
            "error": self.last_error,
        }

    async def set_stream_settings(self, fps: int | None = None, quality: int | None = None, width: int | None = None) -> dict[str, Any]:
        if fps is not None:
            self.settings.stream_fps = max(1, min(60, int(fps)))
        if quality is not None:
            self.settings.stream_quality = max(10, min(100, int(quality)))
        if width is not None:
            self.settings.stream_width = max(0, int(width))
        self.settings.save(decky.DECKY_PLUGIN_SETTINGS_DIR)
        if self.capturer is not None:
            await self.capturer.restart()
        return await self.get_status()

    async def set_enabled(self, enabled: bool) -> dict[str, Any]:
        self.settings.enabled = bool(enabled)
        self.settings.save(decky.DECKY_PLUGIN_SETTINGS_DIR)
        await self._start_server()
        return await self.get_status()

    async def set_port(self, port: int) -> dict[str, Any]:
        port = int(port)
        if not 1024 <= port <= 65535:
            raise ValueError("port must be 1024-65535")
        self.settings.port = port
        self.settings.save(decky.DECKY_PLUGIN_SETTINGS_DIR)
        await self._start_server()
        return await self.get_status()

    async def regenerate_token(self) -> dict[str, Any]:
        self.settings.token = secrets.token_urlsafe(32)
        self.settings.save(decky.DECKY_PLUGIN_SETTINGS_DIR)
        await self._start_server()
        return await self.get_status()

    async def restart_server(self) -> dict[str, Any]:
        await self._start_server()
        return await self.get_status()

    # ---- lifecycle ----

    async def _main(self) -> None:
        self.settings = Settings.load(decky.DECKY_PLUGIN_SETTINGS_DIR)
        decky.logger.info("Decky-MCP starting (python %s)", sys.version.split()[0])
        threading.Thread(target=_loader_watchdog, name="loader-watchdog", daemon=True).start()
        await self._start_server()

    async def _unload(self) -> None:
        await self._stop_server()
        decky.logger.info("Decky-MCP stopped")

    async def _uninstall(self) -> None:
        pass

    async def _migration(self) -> None:
        pass
