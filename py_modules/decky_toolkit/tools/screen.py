"""Tools backed by the full-display capture pipeline."""
import base64
from typing import TYPE_CHECKING, Any

from ..media.capture import CaptureUnavailable, ScreenCapturer
from . import ToolRegistry

if TYPE_CHECKING:
    from .ui import Orientation


def register(reg: ToolRegistry, capturer: ScreenCapturer | None, orient: "Orientation") -> None:
    @reg.add(
        "screen_capture",
        "Capture the full gamescope display (Steam UI, games, overlays: exactly what the screen shows) as a JPEG. "
        "Uses gamescope's PipeWire video node, so it works without a physical display attached. The text part "
        "says where the Steam UI is; trust it over the picture (backgrounds can look like a running game).",
    )
    async def screen_capture() -> list[dict[str, Any]]:
        if capturer is None:
            raise CaptureUnavailable("screen capture not configured")
        frame = await capturer.grab()
        stats = capturer.stats()
        return [
            {"type": "text", "text": f"Display frame {stats.get('width')}x{stats.get('height')}, {len(frame)} bytes\n"
                                     f"{orient.line(await orient.safe())}"},
            {"type": "image", "data": base64.b64encode(frame).decode(), "mimeType": "image/jpeg"},
        ]

    @reg.add(
        "stream_status",
        "The live screen stream: running, fps, bitrate, resolution, viewer count, errors, the audio stream "
        "(enabled, running, kbps, rms_db level) and the settings (change them with stream_settings).",
    )
    async def stream_status() -> dict[str, Any]:
        if capturer is None:
            return {"available": False}
        return capturer.stats()

    @reg.add(
        "stream_settings",
        "The screen stream's settings; give any of fps, quality, width or audio to change them (device-wide: affects "
        "every viewer). Values are clamped to fps 1-60, quality 10-100; width 0 means native (1920). A running video "
        "stream restarts with a sub-second pause; audio=false closes every audio socket. Returns the settings and "
        "their limits.",
        {
            "properties": {
                "fps": {"type": "integer", "minimum": 1, "maximum": 60},
                "quality": {"type": "integer", "minimum": 10, "maximum": 100},
                "width": {"type": "integer", "minimum": 0, "description": "Output width in px; 0 = native. Height follows the aspect ratio."},
                "audio": {"type": "boolean", "description": "Stream what the device is playing alongside the picture (default true)."},
            },
        },
    )
    async def stream_settings(fps: int | None = None, quality: int | None = None, width: int | None = None,
                              audio: bool | None = None) -> dict[str, Any]:
        if capturer is None:
            raise CaptureUnavailable("screen capture not configured")
        return await capturer.update_settings(fps, quality, width, audio)
