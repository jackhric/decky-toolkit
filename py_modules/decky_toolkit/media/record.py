"""Screen recording to Matroska (MJPEG video + 16-bit PCM audio) from the live stream's own frames.

A second gamescope PipeWire consumer is not an option: an encoding gst-launch next to the live pipeline left
gamescope logging "pipewire: warning: out of buffers" 60 times a second, froze the live stream until it was
restarted, and its EOS never completed (verified 2026-11-04). So the recorder subscribes to the existing
ScreenCapturer/AudioCapturer fan-out like any viewer and muxes their JPEG frames and PCM chunks itself: no
re-encode, no extra pipeline, nothing that can disturb the stream.
"""
import asyncio
import os
import re
import shutil
import struct
import time
import weakref
from datetime import datetime
from typing import Any, BinaryIO

from .capture import CaptureUnavailable, ScreenCapturer, jpeg_size

MAX_SECONDS = 120
FIRST_FRAME_TIMEOUT = 8.0
MIN_FREE_BYTES = 2 * 1024 ** 3
EXT = ".mkv"
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
CLUSTER_MS = 1000
CLUSTER_BYTES = 8 * 1024 * 1024
AUDIO_RATE = 48000
AUDIO_CHANNELS = 2
AUDIO_CHUNK_MS = 20
AUDIO_RESYNC_MS = 200


class RecordingBusy(ValueError):
    pass


# ---- EBML / Matroska ----

def _vint_size(n: int) -> bytes:
    for length in range(1, 9):
        if n < (1 << (7 * length)) - 1:
            return (n | (1 << (7 * length))).to_bytes(length, "big")
    raise ValueError("element too large")


def _uint(n: int) -> bytes:
    return n.to_bytes(max(1, (n.bit_length() + 7) // 8), "big")


def el(eid: int, payload: bytes) -> bytes:
    return eid.to_bytes((eid.bit_length() + 7) // 8, "big") + _vint_size(len(payload)) + payload


def el_uint(eid: int, n: int) -> bytes:
    return el(eid, _uint(n))


def el_float(eid: int, x: float) -> bytes:
    return el(eid, struct.pack(">d", x))


def el_str(eid: int, s: str) -> bytes:
    return el(eid, s.encode())


EBML, SEGMENT, SEEKHEAD, SEEK, SEEKID, SEEKPOS = 0x1A45DFA3, 0x18538067, 0x114D9B74, 0x4DBB, 0x53AB, 0x53AC
INFO, TIMESCALE, DURATION, MUXAPP, WRITEAPP = 0x1549A966, 0x2AD7B1, 0x4489, 0x4D80, 0x5741
TRACKS, TRACKENTRY, CLUSTER, TIMECODE, SIMPLEBLOCK = 0x1654AE6B, 0xAE, 0x1F43B675, 0xE7, 0xA3
CUES, CUEPOINT, CUETIME, CUEPOS, CUETRACK, CUECLUSTER = 0x1C53BB6B, 0xBB, 0xB3, 0xB7, 0xF7, 0xF1
VOID = 0xEC
VIDEO_TRACK, AUDIO_TRACK = 1, 2


class MkvWriter:
    """Streams a two-track Matroska file; close() patches the duration, segment size, cues and seek head."""

    def __init__(self, f: BinaryIO, width: int, height: int, audio: bool, app: str = "decky-toolkit") -> None:
        self.f = f
        self.audio = audio
        self.cues: list[tuple[int, int]] = []
        self._cluster = bytearray()
        self._cluster_tc: int | None = None
        self.last_ms = 0
        self.video_frames = 0
        self.audio_chunks = 0
        f.write(el(EBML, el_uint(0x4286, 1) + el_uint(0x42F7, 1) + el_uint(0x42F2, 4) + el_uint(0x42F3, 8)
                   + el_str(0x4282, "matroska") + el_uint(0x4287, 4) + el_uint(0x4285, 2)))
        f.write(SEGMENT.to_bytes(4, "big"))
        self._segment_size_at = f.tell()
        f.write(b"\x01" + b"\xff" * 7)  # unknown size until close()
        self._segment_start = f.tell()
        # Reserve room for the seek head; close() fills it in (the rest stays a Void element).
        self._seekhead_at = f.tell()
        f.write(el(VOID, b"\0" * 120))
        self._info_pos = f.tell() - self._segment_start
        scale = el_uint(TIMESCALE, 1_000_000)
        payload = scale + el_float(DURATION, 0.0) + el_str(MUXAPP, app) + el_str(WRITEAPP, app)
        info = el(INFO, payload)
        # The float sits after the Info header, the TimecodeScale element and Duration's 2-byte id + 1-byte size.
        self._duration_at = f.tell() + len(info) - len(payload) + len(scale) + 3
        f.write(info)
        video = el(TRACKENTRY, el_uint(0xD7, VIDEO_TRACK) + el_uint(0x73C5, VIDEO_TRACK) + el_uint(0x83, 1)
                   + el_str(0x86, "V_MJPEG") + el_uint(0x9C, 0)
                   + el(0xE0, el_uint(0xB0, width) + el_uint(0xBA, height)))
        tracks = video
        if audio:
            tracks += el(TRACKENTRY, el_uint(0xD7, AUDIO_TRACK) + el_uint(0x73C5, AUDIO_TRACK) + el_uint(0x83, 2)
                         + el_str(0x86, "A_PCM/INT/LIT") + el_uint(0x9C, 0)
                         + el(0xE1, el_float(0xB5, float(AUDIO_RATE)) + el_uint(0x9F, AUDIO_CHANNELS) + el_uint(0x6264, 16)))
        self._tracks_pos = f.tell() - self._segment_start
        f.write(el(TRACKS, tracks))

    def _block(self, track: int, ms: int, data: bytes) -> None:
        ms = max(0, int(ms))
        # Block times are signed 16-bit offsets from the cluster time, so audio stamped slightly before the
        # video frame that opened the cluster still fits.
        if self._cluster_tc is not None and (ms - self._cluster_tc >= CLUSTER_MS or ms - self._cluster_tc < -30000
                                             or len(self._cluster) >= CLUSTER_BYTES):
            self.flush()
        if self._cluster_tc is None:
            self._cluster_tc = ms
        rel = ms - self._cluster_tc
        self._cluster += el(SIMPLEBLOCK, bytes([0x80 | track]) + struct.pack(">h", rel) + b"\x80" + data)
        self.last_ms = max(self.last_ms, ms)

    def add_video(self, ms: float, jpeg: bytes) -> None:
        self._block(VIDEO_TRACK, int(ms), jpeg)
        self.video_frames += 1

    def add_audio(self, ms: float, pcm: bytes) -> None:
        if self.audio:
            self._block(AUDIO_TRACK, int(ms), pcm)
            self.audio_chunks += 1

    def flush(self) -> None:
        if self._cluster_tc is None:
            return
        self.cues.append((self._cluster_tc, self.f.tell() - self._segment_start))
        self.f.write(el(CLUSTER, el_uint(TIMECODE, self._cluster_tc) + bytes(self._cluster)))
        self._cluster = bytearray()
        self._cluster_tc = None

    def close(self, duration_ms: float) -> None:
        self.flush()
        cues_pos = self.f.tell() - self._segment_start
        self.f.write(el(CUES, b"".join(
            el(CUEPOINT, el_uint(CUETIME, t) + el(CUEPOS, el_uint(CUETRACK, VIDEO_TRACK) + el_uint(CUECLUSTER, pos)))
            for t, pos in self.cues)))
        end = self.f.tell()
        seekhead = el(SEEKHEAD, b"".join(
            el(SEEK, el(SEEKID, eid.to_bytes(4, "big")) + el(SEEKPOS, pos.to_bytes(8, "big")))
            for eid, pos in ((INFO, self._info_pos), (TRACKS, self._tracks_pos), (CUES, cues_pos))))
        pad = 122 - len(seekhead)  # the reserved Void element is 122 bytes in total
        self.f.seek(self._seekhead_at)
        self.f.write(seekhead + el(VOID, b"\0" * (pad - 2)))
        self.f.seek(self._duration_at)
        self.f.write(struct.pack(">d", float(max(duration_ms, self.last_ms))))
        self.f.seek(self._segment_size_at)
        self.f.write((end - self._segment_start | (1 << 56)).to_bytes(8, "big"))
        self.f.seek(end)


# ---- recorder ----

def recordings_dir() -> str:
    return os.path.join(os.environ.get("DECKY_PLUGIN_RUNTIME_DIR") or "/tmp/decky-toolkit", "recordings")


def check_name(name: str) -> str:
    base = name[:-len(EXT)] if isinstance(name, str) and name.endswith(EXT) else name
    if not isinstance(base, str) or not NAME_RE.match(base) or ".." in base:
        raise ValueError("name must be 1-64 characters of letters, digits, '.', '_' or '-' (no path)")
    return base


class Recorder:
    def __init__(self, capturer: ScreenCapturer, logger=None) -> None:
        self.capturer = capturer
        self.log = logger or capturer.log
        self.active: dict[str, Any] | None = None
        self._task: asyncio.Task[dict[str, Any]] | None = None
        self._stop = asyncio.Event()
        self.last: dict[str, Any] | None = None

    @property
    def dir(self) -> str:
        return recordings_dir()

    def path_for(self, name: str) -> str:
        return os.path.join(self.dir, check_name(name) + EXT)

    async def record(self, seconds: float = 10, fps: int | None = None, with_audio: bool = True,
                     name: str | None = None, wait: bool = True) -> dict[str, Any]:
        if isinstance(seconds, bool) or not isinstance(seconds, (int, float)) or not 0 < seconds <= MAX_SECONDS:
            raise ValueError(f"seconds must be a number in (0, {MAX_SECONDS}]")
        if fps is not None and (isinstance(fps, bool) or not isinstance(fps, int) or not 1 <= fps <= 60):
            raise ValueError("fps must be an integer 1-60")
        if not isinstance(with_audio, bool):
            raise ValueError("with_audio must be true or false")
        name = check_name(name) if name else datetime.now().strftime("rec-%Y%m%d-%H%M%S")
        if self._task is not None and not self._task.done():
            raise RecordingBusy(f"a recording is already running ({self.active['name'] if self.active else '?'}); "
                                "wait for it or call screen_record_stop")
        reason = self.capturer.unavailable_reason()
        if reason:
            raise CaptureUnavailable(reason)
        os.makedirs(self.dir, exist_ok=True)
        path = self.path_for(name)
        if os.path.exists(path):
            raise ValueError(f"a recording named {name} already exists")
        if shutil.disk_usage(self.dir).free < MIN_FREE_BYTES:
            raise ValueError(f"less than {MIN_FREE_BYTES >> 30} GiB free in {self.dir}")
        stream_fps = int(getattr(self.capturer._get_settings(), "stream_fps", 30))
        fps = min(fps or stream_fps, stream_fps)
        self._stop = asyncio.Event()
        self.active = {"name": name, "path": path, "seconds": seconds, "fps": fps, "started": time.time()}
        self._task = asyncio.create_task(self._run(path, float(seconds), fps, with_audio))
        # With wait=false nobody awaits the task; its failure is kept in self.last instead.
        self._task.add_done_callback(lambda t: t.cancelled() or t.exception())
        if not wait:
            return {"recording": True, **self.active, "note": "call recording_list to see when it is finished"}
        return await asyncio.shield(self._task)

    async def stop(self) -> dict[str, Any]:
        if self._task is None or self._task.done():
            return {"recording": False}
        self._stop.set()
        return await asyncio.shield(self._task)

    async def _run(self, path: str, seconds: float, fps: int, with_audio: bool) -> dict[str, Any]:
        part = path + ".part"
        audio = self.capturer.audio if with_audio else None
        audio_note = None
        if with_audio and (audio is None or not audio.enabled or audio.unavailable_reason()):
            audio = None
            audio_note = "audio skipped: " + ("audio streaming is disabled in the stream settings"
                                              if self.capturer.audio is not None and not self.capturer.audio.enabled
                                              else "no audio capture available")
        f = open(part, "wb")
        writer: MkvWriter | None = None
        state = {"t0": 0.0, "next_audio_ms": None, "last_frame_t": -1.0}
        first = asyncio.Event()
        min_gap = 1.0 / fps - 0.004

        async def video() -> None:
            nonlocal writer
            async for frame in self.capturer.subscribe():
                now = time.monotonic()
                if writer is None:
                    size = jpeg_size(frame) or (1920, 1080)
                    writer = MkvWriter(f, size[0], size[1], audio is not None)
                    state["t0"] = now
                    first.set()
                elif now - state["last_frame_t"] < min_gap:
                    continue  # recording at a lower rate than the live stream
                state["last_frame_t"] = now
                writer.add_video((now - state["t0"]) * 1000, frame)

        async def sound() -> None:
            assert audio is not None
            async for chunk in audio.subscribe():
                if writer is None:
                    continue
                arrival = (time.monotonic() - state["t0"]) * 1000 - AUDIO_CHUNK_MS
                nxt = state["next_audio_ms"]
                # Chunks are contiguous samples; stamp them back to back and only resync after a real gap.
                ms = arrival if nxt is None or abs(arrival - nxt) > AUDIO_RESYNC_MS else nxt
                if ms >= 0:
                    writer.add_audio(ms, chunk)
                state["next_audio_ms"] = ms + AUDIO_CHUNK_MS

        tasks = [asyncio.create_task(video())]
        if audio is not None:
            tasks.append(asyncio.create_task(sound()))
        error: str | None = None
        try:
            first_wait = asyncio.create_task(first.wait())
            await asyncio.wait([tasks[0], first_wait], timeout=FIRST_FRAME_TIMEOUT, return_when=asyncio.FIRST_COMPLETED)
            first_wait.cancel()
            if not first.is_set():
                if tasks[0].done() and tasks[0].exception():
                    raise tasks[0].exception()  # type: ignore[misc]
                raise CaptureUnavailable(f"no frame within {FIRST_FRAME_TIMEOUT:.0f}s")
            stop_wait = asyncio.create_task(self._stop.wait())
            await asyncio.wait([stop_wait, *tasks], timeout=seconds, return_when=asyncio.FIRST_COMPLETED)
            stop_wait.cancel()
            for t in tasks:
                if t.done() and t.exception() and t is tasks[0]:
                    error = f"video ended early: {t.exception()}"
                elif t.done() and t.exception():
                    audio_note = f"audio ended early: {t.exception()}"
        except BaseException as e:
            for t in tasks:
                t.cancel()
            f.close()
            try:
                os.remove(part)
            except OSError:
                pass
            self.active = None
            self.last = {"path": path, "error": f"{type(e).__name__}: {e}"}
            raise
        duration = (time.monotonic() - state["t0"]) * 1000
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        assert writer is not None
        writer.close(duration)
        f.close()
        os.replace(part, path)
        self.active = None
        result: dict[str, Any] = {
            "name": os.path.basename(path)[:-len(EXT)], "path": path, "size": os.path.getsize(path),
            "duration_s": round(duration / 1000, 2), "frames": writer.video_frames,
            "fps": round(writer.video_frames / (duration / 1000), 1) if duration > 0 else 0,
            "audio": writer.audio, "format": "Matroska (MJPEG + PCM s16le 48 kHz stereo)",
            "download": f"/recordings/{os.path.basename(path)[:-len(EXT)]}",
        }
        if writer.audio:
            result["audio_chunks"] = writer.audio_chunks
        if audio_note:
            result["audio_note"] = audio_note
        if error:
            result["error"] = error
        self.last = result
        self.log.info("recording saved: %s (%s bytes, %.1fs)", path, result["size"], result["duration_s"])
        return result

    def list(self) -> dict[str, Any]:
        out = []
        try:
            entries = sorted(os.scandir(self.dir), key=lambda e: e.name)
        except OSError:
            entries = []
        for e in entries:
            if e.is_file() and e.name.endswith(EXT):
                st = e.stat()
                out.append({"name": e.name[:-len(EXT)], "path": e.path, "size": st.st_size,
                            "modified": datetime.fromtimestamp(st.st_mtime).isoformat(timespec="seconds"),
                            "download": f"/recordings/{e.name[:-len(EXT)]}"})
        return {"dir": self.dir, "recordings": out, "active": self.active, "last": self.last}

    def delete(self, name: str, confirm: bool = False) -> dict[str, Any]:
        if confirm is not True:
            raise ValueError("recording_delete is destructive: pass confirm=true")
        path = self.path_for(name)
        if self.active and self.active["path"] == path:
            raise RecordingBusy("that recording is still being written")
        if not os.path.isfile(path):
            raise FileNotFoundError(f"no recording named {check_name(name)}")
        size = os.path.getsize(path)
        os.remove(path)
        return {"deleted": path, "bytes": size}


_recorders: "weakref.WeakKeyDictionary[ScreenCapturer, Recorder]" = weakref.WeakKeyDictionary()


def recorder_for(capturer: ScreenCapturer) -> Recorder:
    """One recorder per capturer, shared by the MCP tools and the HTTP routes."""
    rec = _recorders.get(capturer)
    if rec is None:
        rec = _recorders[capturer] = Recorder(capturer)
    return rec
