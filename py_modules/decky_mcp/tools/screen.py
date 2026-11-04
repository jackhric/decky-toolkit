"""Tools backed by the full-display capture pipeline."""
import base64
from typing import Any

from ..capture import CaptureUnavailable, ScreenCapturer
from . import ToolRegistry


def register(reg: ToolRegistry, capturer: ScreenCapturer | None) -> None:
    @reg.add(
        "screen_capture",
        "Capture the full gamescope display (Steam UI, games, overlays: exactly what the screen shows) as a JPEG. "
        "Uses gamescope's PipeWire video node, so it works without a physical display attached.",
    )
    async def screen_capture() -> list[dict[str, Any]]:
        if capturer is None:
            raise CaptureUnavailable("screen capture not configured")
        frame = await capturer.grab()
        stats = capturer.stats()
        return [
            {"type": "text", "text": f"Display frame {stats.get('width')}x{stats.get('height')}, {len(frame)} bytes"},
            {"type": "image", "data": base64.b64encode(frame).decode(), "mimeType": "image/jpeg"},
        ]

    @reg.add("stream_status", "Report the live screen stream state: running, fps, bitrate, resolution, viewer count, errors.")
    async def stream_status() -> dict[str, Any]:
        if capturer is None:
            return {"available": False}
        return capturer.stats()
