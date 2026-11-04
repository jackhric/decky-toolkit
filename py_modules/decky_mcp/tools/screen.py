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

    @reg.add(
        "stream_status",
        "Report the live screen stream state: running, fps, bitrate, resolution, viewer count, errors, "
        "plus the configured settings and their limits.",
    )
    async def stream_status() -> dict[str, Any]:
        if capturer is None:
            return {"available": False}
        return capturer.stats()

    @reg.add(
        "set_stream_settings",
        "Change the screen stream's frame rate, JPEG quality and/or output width (device-wide: affects every viewer). "
        "Values are clamped to fps 1-60, quality 10-100; width 0 means native (1920). A running stream restarts "
        "with a sub-second pause. Returns the new settings.",
        {
            "properties": {
                "fps": {"type": "integer", "minimum": 1, "maximum": 60},
                "quality": {"type": "integer", "minimum": 10, "maximum": 100},
                "width": {"type": "integer", "minimum": 0, "description": "Output width in px; 0 = native. Height follows the aspect ratio."},
            },
        },
    )
    async def set_stream_settings(fps: int | None = None, quality: int | None = None, width: int | None = None) -> dict[str, Any]:
        if capturer is None:
            raise CaptureUnavailable("screen capture not configured")
        return await capturer.update_settings(fps, quality, width)
