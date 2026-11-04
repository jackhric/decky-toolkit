"""Self-update tools for the toolkit plugin itself."""
from typing import Any

from . import ToolRegistry
from ..update import Updater


def register(reg: ToolRegistry, updater: "Updater | None") -> None:
    if updater is None:
        return

    @reg.add(
        "check_toolkit_update",
        "Check the published release manifest for a newer Decky Toolkit plugin and report the current and latest "
        "versions, whether an update is available, whether automatic updates are on and whether the device is busy "
        "(a live screen or audio stream defers automatic updates).",
    )
    async def check_toolkit_update() -> dict[str, Any]:
        return await updater.check()

    @reg.add(
        "apply_toolkit_update",
        "Download the newest Decky Toolkit plugin release, verify its sha256 and install it; the loader restarts 1 s "
        "after the reply, so this server is unreachable for about 10 s and the Steam UI reloads. Fails when already "
        "up to date or while an update is being applied.",
    )
    async def apply_toolkit_update() -> dict[str, Any]:
        return await updater.apply()

    @reg.add(
        "set_toolkit_auto_update",
        "Turn automatic Decky Toolkit updates on or off (on by default). When on, a newer release found by the "
        "periodic check is installed as soon as no screen or audio stream is live.",
        {"properties": {"enabled": {"type": "boolean"}}, "required": ["enabled"]},
    )
    async def set_toolkit_auto_update(enabled: bool) -> dict[str, Any]:
        return await updater.set_auto_update(enabled)
