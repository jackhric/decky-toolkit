"""Screen recording tools."""
import asyncio
from typing import Any

from ..media.capture import ScreenCapturer
from ..media.record import MAX_SECONDS, recorder_for
from . import ToolRegistry


def register(reg: ToolRegistry, capturer: ScreenCapturer) -> None:
    def rec():
        return recorder_for(capturer)

    @reg.add(
        "screen_record",
        f"Record the screen (plus what the device plays, unless with_audio=false) for up to {MAX_SECONDS} s into "
        "DECKY_PLUGIN_RUNTIME_DIR/recordings/<name>.mkv (Matroska, MJPEG + PCM; plays in mpv/VLC/ffmpeg). Uses the "
        "live stream's frames, so resolution, quality and the maximum fps follow the stream settings and viewers "
        "are not disturbed. One recording at a time. Returns path, size and duration. "
        "wait=false returns at once; see recording_list / screen_record_stop.",
        {"properties": {
            "seconds": {"type": "number", "default": 10, "minimum": 1, "maximum": MAX_SECONDS},
            "fps": {"type": "integer", "minimum": 1, "maximum": 60, "description": "Defaults to (and is capped at) the stream fps"},
            "with_audio": {"type": "boolean", "default": True},
            "name": {"type": "string", "description": "File name without extension; default rec-<date>-<time>"},
            "wait": {"type": "boolean", "default": True},
        }},
    )
    async def screen_record(seconds: float = 10, fps: int | None = None, with_audio: bool = True,
                            name: str | None = None, wait: bool = True) -> dict[str, Any]:
        return await rec().record(seconds, fps, with_audio, name, wait)

    @reg.add("screen_record_stop", "Stop the running recording early and return its result.")
    async def screen_record_stop() -> dict[str, Any]:
        return await rec().stop()

    @reg.add("recording_list", "List saved recordings (name, path, size, modified) and the active one.")
    async def recording_list() -> dict[str, Any]:
        return await asyncio.to_thread(rec().list)

    @reg.add(
        "recording_delete",
        "Delete a saved recording by name. Requires confirm=true.",
        {"properties": {"name": {"type": "string"}, "confirm": {"type": "boolean"}}, "required": ["name", "confirm"]},
    )
    async def recording_delete(name: str, confirm: bool = False) -> dict[str, Any]:
        return rec().delete(name, confirm)
