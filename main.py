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

from decky_toolkit.audio import AudioCapturer  # noqa: E402
from decky_toolkit.auth import TokenAuth  # noqa: E402
from decky_toolkit.capture import ScreenCapturer  # noqa: E402
from decky_toolkit.http import Api  # noqa: E402
from decky_toolkit.controllers import ControllerService  # noqa: E402
from decky_toolkit.input.service import InputService  # noqa: E402
from decky_toolkit.pairing import PairingRequest, PairingRequests  # noqa: E402
from decky_toolkit.protocol import McpServer  # noqa: E402
from decky_toolkit.settings import Settings  # noqa: E402
from decky_toolkit.tools import build_registry  # noqa: E402
from decky_toolkit.ui import UiNavigator  # noqa: E402


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


class Plugin:
    settings: Settings
    runner: web.AppRunner | None = None
    capturer: ScreenCapturer | None = None
    audio: AudioCapturer | None = None
    input: InputService | None = None
    controllers: ControllerService | None = None
    ui: UiNavigator | None = None
    pairing: PairingRequests
    pruner: asyncio.Task | None = None
    last_error: str | None = None

    async def _start_server(self) -> None:
        await self._stop_server()
        if not self.settings.enabled:
            return
        api = Api(
            auth=TokenAuth(self.settings.token),
            mcp=McpServer(build_registry(self.capturer, self.input, self.controllers, self.ui), decky.logger),
            capturer=self.capturer,
            static_dir=os.path.join(decky.DECKY_PLUGIN_DIR, "static"),
            logger=decky.logger,
            pairing=self.pairing,
            base_url=self._base_url,
            input_service=self.input,
            audio=self.audio,
            controllers=self.controllers,
            ui=self.ui,
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
        if self.input is not None:
            await self.input.shutdown()
        if self.capturer is not None:
            await self.capturer.stop()
        if self.audio is not None:
            await self.audio.stop()
        if self.runner is not None:
            await self.runner.cleanup()
            self.runner = None

    def _base_url(self, ip: str | None = None) -> str:
        return f"http://{ip or _primary_ip()}:{self.settings.port}"

    # ---- pairing ----

    def _on_pairing_change(self, event: str, req: PairingRequest | None) -> None:
        if event == "create" and req is not None:
            info = {"id": req.id, "code": req.code, "client_name": req.client_name, "client_kind": req.client_kind,
                    "remote": req.remote}
            asyncio.ensure_future(decky.emit("decky_toolkit_pair_request", info))
        asyncio.ensure_future(decky.emit("decky_toolkit_pair_requests", self.pairing.list()))

    async def list_pair_requests(self) -> list[dict[str, Any]]:
        return self.pairing.list()

    async def approve_pair_request(self, request_id: str) -> list[dict[str, Any]]:
        req = self.pairing.approve(request_id)
        decky.logger.info("pairing: approved %s (%s) from %s", req.client_name, req.client_kind, req.remote)
        await decky.emit("decky_toolkit_paired", req.remote, req.client_name)
        return self.pairing.list()

    async def deny_pair_request(self, request_id: str) -> list[dict[str, Any]]:
        req = self.pairing.deny(request_id)
        decky.logger.info("pairing: denied %s (%s) from %s", req.client_name, req.client_kind, req.remote)
        return self.pairing.list()

    async def _on_input_session(self, remote: str) -> None:
        decky.logger.info("input session toast: remote input from %s", remote)
        await decky.emit("decky_toolkit_input_session", remote)

    # ---- methods callable from the frontend ----

    async def get_input_settings(self) -> dict[str, Any]:
        assert self.input is not None  # created in _main
        return self.input.status()

    async def set_input_enabled(self, enabled: bool) -> dict[str, Any]:
        assert self.input is not None
        return await self.input.set_enabled(bool(enabled))

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
            "pair_requests": len(self.pairing.pending()),
            "stream": self.capturer.stats() if self.capturer else None,
            "input": self.input.status() if self.input else None,
            "error": self.last_error,
        }

    async def set_stream_settings(self, fps: int | None = None, quality: int | None = None, width: int | None = None,
                                  audio: bool | None = None) -> dict[str, Any]:
        assert self.capturer is not None  # created in _main
        await self.capturer.update_settings(fps, quality, width, audio)
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
        decky.logger.info("Decky Toolkit starting (python %s)", sys.version.split()[0])
        threading.Thread(target=_loader_watchdog, name="loader-watchdog", daemon=True).start()
        save = lambda: self.settings.save(decky.DECKY_PLUGIN_SETTINGS_DIR)  # noqa: E731
        self.pairing = PairingRequests(on_change=self._on_pairing_change)
        self.pruner = asyncio.create_task(self.pairing.run_pruner())
        self.capturer = ScreenCapturer(lambda: self.settings, decky.logger, save_settings=save)
        self.audio = AudioCapturer(lambda: self.settings, decky.logger)
        self.capturer.audio = self.audio
        self.input = InputService(lambda: self.settings, save, decky.logger, on_session=self._on_input_session)
        # The panel mirrors a setting that remote clients usually change, so push changes to it.
        self.input.add_listener(lambda st: asyncio.ensure_future(decky.emit("decky_toolkit_input_state", st["enabled"])))
        self.controllers = ControllerService(self.input, decky.logger)
        self.ui = UiNavigator()
        await self._start_server()

    async def _unload(self) -> None:
        if self.pruner is not None:
            self.pruner.cancel()
        await self._stop_server()
        decky.logger.info("Decky Toolkit stopped")

    async def _uninstall(self) -> None:
        pass

    async def _migration(self) -> None:
        pass
