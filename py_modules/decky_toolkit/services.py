"""The long-lived services, built once by main.py and shared by the HTTP routes and the MCP tools. Each one that
changes device state reports it to `events` itself."""
import logging
from dataclasses import dataclass
from typing import Callable

from .input.activity import InputActivity
from .input.controllers import ControllerService
from .input.service import InputService
from .media.audio import AudioCapturer
from .media.capture import ScreenCapturer
from .server.events import EventHub
from .server.pairing import PairingRequests
from .settings import Settings
from .steam.apps import Apps
from .steam.console import ConsoleCollector
from .steam.perf import PerfOverlay
from .steam.plugin_tools import PluginTools
from .steam.ui import UiInspector, UiNavigator


@dataclass
class Services:
    events: EventHub
    capturer: ScreenCapturer
    audio: AudioCapturer
    input: InputService
    controllers: ControllerService
    ui: UiNavigator
    inspector: UiInspector
    apps: Apps
    perf: PerfOverlay
    console: ConsoleCollector
    activity: InputActivity
    plugin_tools: PluginTools
    pairing: PairingRequests

    @classmethod
    def create(cls, get_settings: Callable[[], Settings], save_settings: Callable[[], None], logger: logging.Logger,
               events: EventHub, server_cert: str) -> "Services":
        capturer = ScreenCapturer(get_settings, logger, events, save_settings=save_settings)
        capturer.audio = audio = AudioCapturer(get_settings, logger)
        input_service = InputService(get_settings, save_settings, logger, events)
        ui = UiNavigator()
        return cls(
            events=events, capturer=capturer, audio=audio, input=input_service,
            controllers=ControllerService(input_service, logger, events), ui=ui, inspector=UiInspector(ui), apps=Apps(), perf=PerfOverlay(),
            console=ConsoleCollector(logger), activity=InputActivity(logger), plugin_tools=PluginTools(logger, events),
            pairing=PairingRequests(events, server_cert),
        )

    def start(self) -> None:
        # Each only schedules its tasks, so a Steam without CEF cannot hold up startup.
        self.console.start()
        self.activity.start()
        self.plugin_tools.start()

    async def stop(self) -> None:
        await self.console.stop()
        await self.activity.stop()
        await self.plugin_tools.stop()
