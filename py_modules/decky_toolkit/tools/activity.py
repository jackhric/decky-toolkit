"""device_activity: is someone using the device, at it or remotely, and what is in front."""
import asyncio
import time
from typing import Any

from ..input.activity import AT_DEVICE_SECONDS, InputActivity, someone_at_device
from ..input.service import InputService
from ..media.capture import ScreenCapturer
from ..steam import cdp
from ..steam.ui import UiNavigator
from . import ToolRegistry


def register(reg: ToolRegistry, activity: InputActivity, input_service: InputService, capturer: ScreenCapturer,
             nav: UiNavigator) -> None:

    @reg.add(
        "device_activity",
        "Is someone using the device? Check before anything that moves the UI under a person (navigation, input, "
        "reloads that reopen pages, launching games). Returns {someone_at_device (physical input within "
        "active_within s), remote_input_active (input injected through Decky Toolkit within active_within s), "
        "physical {devices [{name, id, event, seconds_ago}], last}, remote {client, kind, seconds_ago}, foreground "
        "{current, side_menu, running_app}, screen_viewers}. Physical input is read from every non-virtual input "
        "device (times only, never contents).",
        {"properties": {"active_within": {"type": "number", "default": AT_DEVICE_SECONDS, "minimum": 1, "maximum": 86400}}},
    )
    async def device_activity(active_within: float = AT_DEVICE_SECONDS) -> dict[str, Any]:
        now = time.time()
        physical = activity.snapshot()
        remote = None
        if input_service.last_remote:
            r = input_service.last_remote
            remote = {"client": r["client"], "kind": r["kind"], "seconds_ago": round(now - r["at"], 1)}
        try:
            state = await nav.state()
            foreground = {k: state.get(k) for k in ("current", "side_menu", "running_app")}
        except (cdp.CdpError, OSError, asyncio.TimeoutError) as e:
            foreground = {"error": str(e)}
        return {
            "someone_at_device": someone_at_device(physical, active_within),
            "remote_input_active": bool(remote and remote["seconds_ago"] <= active_within),
            "physical": physical,
            "remote": remote,
            "foreground": foreground,
            "screen_viewers": capturer.stats()["subscribers"],
        }
