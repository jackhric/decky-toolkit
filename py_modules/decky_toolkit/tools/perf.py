"""perf_overlay: Steam's performance overlay level."""
from typing import Any

from ..steam.perf import PerfOverlay
from . import ToolRegistry


def register(reg: ToolRegistry, perf: PerfOverlay) -> None:
    @reg.add(
        "perf_overlay",
        "Steam's performance overlay (MangoHud): its level (0-4 as on the Quick Access performance tab), service "
        "state (enabled/available/standalone), whether it shows over the Steam UI, and the game ids of Steam's current "
        "game and active performance profile. Give level to set it: 0 off, 1 fps only, 2 basic, 3 medium, 4 full; it "
        "draws over games, show_over_steam=true also over the Steam UI. mangoapp is a gamescope external overlay, "
        "which gamescope does not paint into its PipeWire stream, so screen_capture and recordings never show it; "
        "check the level here or on the Quick Access performance tab (ui_navigate action=quick_access tab=perf "
        "capture=true).",
        {"properties": {"level": {"type": "integer", "minimum": 0, "maximum": 4},
                        "show_over_steam": {"type": "boolean"}}},
    )
    async def perf_overlay(level: int | None = None, show_over_steam: bool | None = None) -> dict[str, Any]:
        if level is None:
            if show_over_steam is not None:
                raise ValueError("show_over_steam needs level")
            return await perf.status()
        return await perf.set(level, show_over_steam)
