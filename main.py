import asyncio
import os
import socket
import ssl
import sys
import threading
import time
from typing import Any

import decky
from aiohttp import web

sys.path.append(decky.DECKY_PLUGIN_DIR + "/py_modules")  # the loader does this too; kept for IDE/type tooling parity

from decky_toolkit.server.advertise import Advertiser, txt_records  # noqa: E402
from decky_toolkit.media.audio import AudioCapturer  # noqa: E402
from decky_toolkit.server.auth import CertAuth, Connections  # noqa: E402
from decky_toolkit.media.capture import ScreenCapturer  # noqa: E402
from decky_toolkit.steam.console import ConsoleCollector  # noqa: E402
from decky_toolkit.server import API_VERSIONS  # noqa: E402
from decky_toolkit.server.events import EventHub  # noqa: E402
from decky_toolkit.server.http import Api  # noqa: E402
from decky_toolkit.server.identity import identity  # noqa: E402
from decky_toolkit.input.controllers import ControllerService  # noqa: E402
from decky_toolkit.input.activity import InputActivity  # noqa: E402
from decky_toolkit.input.service import InputService  # noqa: E402
from decky_toolkit import diagnostics  # noqa: E402
from decky_toolkit.loader import fixes as loader_fixes  # noqa: E402
from decky_toolkit.server.pairing import PairingRequest, PairingRequests  # noqa: E402
from decky_toolkit.server.protocol import SERVER_INFO, McpServer  # noqa: E402
from decky_toolkit.settings import Settings  # noqa: E402
from decky_toolkit.server.tls import Identity, PairedClients, TlsError, fingerprint  # noqa: E402
from decky_toolkit.tools import build_registry  # noqa: E402
from decky_toolkit.tools.plugin_tools import PluginTools  # noqa: E402
from decky_toolkit.tools.system import list_plugins  # noqa: E402
from decky_toolkit.steam.ui import UiNavigator  # noqa: E402


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
    console: ConsoleCollector | None = None
    activity: InputActivity | None = None
    plugin_tools: PluginTools | None = None
    identity: Identity
    events: EventHub
    clients: PairedClients
    pairing: PairingRequests
    connections: Connections
    pruner: asyncio.Task | None = None
    advertiser: Advertiser | None = None
    last_error: str | None = None

    async def _start_server(self) -> None:
        await self._stop_server()
        if not self.settings.enabled or not self.identity.cert_pem:
            return
        try:
            ssl_context = self.identity.server_context()
        except (ssl.SSLError, OSError) as e:
            self.last_error = f"could not load the device identity: {e}"
            decky.logger.error(self.last_error)
            return
        registry = build_registry(self.capturer, self.input, self.controllers, self.ui, console=self.console,
                                  activity=self.activity, plugin_tools=self.plugin_tools, events=self.events)
        self.events.sources["tools"] = lambda: {"hash": registry.fingerprint()}
        api = Api(
            auth=CertAuth(self.clients, connections=self.connections),
            mcp=McpServer(registry, decky.logger),
            capturer=self.capturer,
            logger=decky.logger,
            pairing=self.pairing,
            input_service=self.input,
            audio=self.audio,
            controllers=self.controllers,
            ui=self.ui,
            events=self.events,
        )
        # The loader SIGKILLs a plugin 5s after SIGTERM, so never wait long for in-flight requests.
        runner = web.AppRunner(api.build_app(), access_log=None, shutdown_timeout=2)
        await runner.setup()
        # A previous instance may still be releasing the port (loader restart races, orphaned
        # backends on their way out), so retry for a while before giving up.
        for attempt in range(15):
            try:
                await web.TCPSite(runner, self.settings.bind, self.settings.port, reuse_address=True,
                                  ssl_context=ssl_context).start()
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
        decky.logger.info("MCP server listening on https://%s:%s/mcp", self.settings.bind, self.settings.port)
        if not self.settings.bind.startswith("127."):
            self.advertiser = Advertiser(decky.logger, self.settings.port,
                                         txt_records(SERVER_INFO["version"], API_VERSIONS, identity()["device_id"]))
            self.advertiser.start()

    async def _stop_server(self) -> None:
        if self.advertiser is not None:
            await self.advertiser.stop()
            self.advertiser = None
        if self.input is not None:
            await self.input.shutdown()
        if self.capturer is not None:
            await self.capturer.stop()
        if self.audio is not None:
            await self.audio.stop()
        if self.runner is not None:
            await self.runner.cleanup()
            self.runner = None

    # ---- pairing ----

    def _on_pairing_change(self, event: str, req: PairingRequest | None) -> None:
        if event == "create" and req is not None:
            info = {"id": req.id, "code": req.code, "client_name": req.client_name, "client_kind": req.client_kind,
                    "remote": req.remote}
            self.events.frontend("decky_toolkit_pair_request", info)
        self.events.frontend("decky_toolkit_pair_requests", self.pairing.list())
        self.events.refresh("pairing")

    async def list_pair_requests(self) -> list[dict[str, Any]]:
        return self.pairing.list()

    async def approve_pair_request(self, request_id: str) -> list[dict[str, Any]]:
        req = self.pairing.pending_request(request_id)
        cert = await self.identity.sign_client(req.public_key, req.client_name)
        self.pairing.approve(request_id, cert)
        self.clients.add(fingerprint(cert), req.client_name, req.client_kind)
        decky.logger.info("pairing: approved %s (%s) from %s", req.client_name, req.client_kind, req.remote)
        self.events.frontend("decky_toolkit_paired", req.remote, req.client_name)
        return self.pairing.list()

    async def deny_pair_request(self, request_id: str) -> list[dict[str, Any]]:
        req = self.pairing.deny(request_id)
        decky.logger.info("pairing: denied %s (%s) from %s", req.client_name, req.client_kind, req.remote)
        return self.pairing.list()

    def _on_clients_change(self, clients: list[dict[str, Any]]) -> None:
        self.events.frontend("decky_toolkit_paired_clients", clients)
        self.events.refresh("pairing")

    async def list_paired_clients(self) -> list[dict[str, Any]]:
        return self.clients.list()

    async def forget_paired_client(self, fp: str) -> list[dict[str, Any]]:
        if not self.clients.remove(fp):
            raise ValueError("unknown paired client")
        closed = self.connections.close(fp)
        decky.logger.info("pairing: forgot client %s, closed %d connection(s)", fp[:16], closed)
        return self.clients.list()

    async def _on_input_session(self, remote: str) -> None:
        decky.logger.info("input session toast: remote input from %s", remote)
        self.events.frontend("decky_toolkit_input_session", remote)

    # ---- events ----

    def _on_input_state(self, state: dict[str, Any]) -> None:
        # The panel mirrors a setting that remote clients usually change.
        self.events.frontend("decky_toolkit_input_state", state["enabled"])
        self.events.refresh("input_settings")

    def _add_event_sources(self) -> None:
        """What `hello` carries and `refresh` recomputes; "tools" follows the registry of each server start."""
        assert self.capturer is not None and self.input is not None and self.controllers is not None
        controllers = self.controllers

        async def plugins() -> dict[str, Any]:
            return {"plugins": [{k: p.get(k) for k in ("dir", "name", "version")} for p in await list_plugins()]}

        async def controller_list() -> dict[str, Any]:
            return controllers.event(await controllers.snapshot())

        self.events.sources.update({
            "stream_settings": self.capturer.stream_settings,
            "input_settings": self.input.status,
            "plugins": plugins,
            "controllers": controller_list,
            "pairing": lambda: {"pending": len(self.pairing.pending()), "paired": len(self.clients.list())},
        })

    # ---- methods callable from the frontend ----

    async def get_input_settings(self) -> dict[str, Any]:
        assert self.input is not None  # created in _main
        return self.input.status()

    async def set_input_enabled(self, enabled: bool) -> dict[str, Any]:
        assert self.input is not None
        return await self.input.set_enabled(bool(enabled))

    def _connected_clients(self) -> list[dict[str, Any]]:
        return [{**{k: c[k] for k in ("name", "kind", "remote", "connected_since", "fingerprint")},
                 "streaming": self.connections.streaming(c["fingerprint"])}
                for c in self.clients.connected_clients()]

    async def get_status(self) -> dict[str, Any]:
        return {
            "enabled": self.settings.enabled,
            "running": self.runner is not None,
            "bind": self.settings.bind,
            "port": self.settings.port,
            "ip": _primary_ip(),
            "pair_requests": len(self.pairing.pending()),
            "stream": self.capturer.stats() if self.capturer else None,
            "input": self.input.status() if self.input else None,
            "error": self.last_error,
            "connected": self.clients.any_connected(),
            "clients": self._connected_clients(),
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

    async def restart_server(self) -> dict[str, Any]:
        await self._start_server()
        return await self.get_status()

    # ---- lifecycle ----

    async def _main(self) -> None:
        self.settings = Settings.load(decky.DECKY_PLUGIN_SETTINGS_DIR)
        decky.logger.info("Decky Toolkit starting (python %s)", sys.version.split()[0])
        loader_fixes.patch_socket_eof(decky.logger)
        diagnostics.install(decky.logger, os.path.join(decky.DECKY_PLUGIN_RUNTIME_DIR, "stacks.txt"))
        threading.Thread(target=_loader_watchdog, name="loader-watchdog", daemon=True).start()
        save = lambda: self.settings.save(decky.DECKY_PLUGIN_SETTINGS_DIR)  # noqa: E731
        self.events = EventHub(decky.emit, decky.logger)
        self.identity = Identity(decky.DECKY_PLUGIN_SETTINGS_DIR)
        try:
            await self.identity.ensure()
        except (TlsError, OSError, ValueError) as e:
            self.last_error = f"could not create the device identity: {e}"
            decky.logger.error(self.last_error)
        self.clients = PairedClients(self.identity.clients_path, on_change=self._on_clients_change)
        self.connections = Connections()
        self.pairing = PairingRequests(self.identity.cert_pem, on_change=self._on_pairing_change)
        self.pruner = asyncio.create_task(self.pairing.run_pruner())
        self.capturer = ScreenCapturer(lambda: self.settings, decky.logger, save_settings=save)
        self.audio = AudioCapturer(lambda: self.settings, decky.logger)
        self.capturer.audio = self.audio
        self.capturer.on_settings_change = lambda: self.events.refresh("stream_settings")
        self.input = InputService(lambda: self.settings, save, decky.logger, on_session=self._on_input_session)
        self.input.add_listener(self._on_input_state)
        self.controllers = ControllerService(self.input, decky.logger, events=self.events)
        self.ui = UiNavigator()
        # Only schedules its connection tasks, so a Steam without CEF cannot hold up startup.
        self.console = ConsoleCollector(decky.logger)
        self.console.start()
        self.activity = InputActivity(decky.logger)
        self.activity.start()
        self.plugin_tools = PluginTools(decky.logger, events=self.events)
        self.plugin_tools.start()
        self._add_event_sources()
        await self._start_server()

    async def _unload(self) -> None:
        if self.pruner is not None:
            self.pruner.cancel()
        if self.console is not None:
            await self.console.stop()
        if self.activity is not None:
            await self.activity.stop()
        if self.plugin_tools is not None:
            await self.plugin_tools.stop()
        await self._stop_server()
        decky.logger.info("Decky Toolkit stopped")

    async def _uninstall(self) -> None:
        pass

    async def _migration(self) -> None:
        pass
