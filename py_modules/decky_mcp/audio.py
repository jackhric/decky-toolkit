"""Live audio: the default sink's monitor (what the device is playing) -> GStreamer -> raw PCM chunks.

Same shape as capture.py: one gst-launch subprocess, started by the first subscriber, stopped 10 s
after the last one leaves, fanned out to any number of WebSocket clients.
"""
import array
import asyncio
import collections
import math
import os
import shutil
import signal
import sys
import time
from typing import AsyncIterator, Callable

from .capture import IDLE_STOP_SECONDS, _user_runtime_dir
from .settings import Settings

RATE = 48000
CHANNELS = 2
CHUNK_MS = 20
CHUNK_BYTES = RATE * CHANNELS * 2 * CHUNK_MS // 1000  # 3840
FORMAT = {"type": "format", "codec": "pcm_s16le", "rate": RATE, "channels": CHANNELS, "chunk_ms": CHUNK_MS}
MAX_BACKLOG_CHUNKS = 500 // CHUNK_MS
# None = the default sink (follows changes of the default); gamescope's own sink as a fallback.
TARGETS = (None, "gamescope")


class AudioUnavailable(RuntimeError):
    pass


class AudioDisabled(RuntimeError):
    pass


_DISABLED = object()


class AudioCapturer:
    def __init__(self, get_settings: Callable[[], Settings], logger, idle_stop: float = IDLE_STOP_SECONDS) -> None:
        self._get_settings = get_settings
        self.log = logger
        self.idle_stop = idle_stop
        self._proc: asyncio.subprocess.Process | None = None
        self._reader_task: asyncio.Task[None] | None = None
        self._idle_task: asyncio.Task[None] | None = None
        self._subs: set[asyncio.Queue] = set()
        self._stderr = collections.deque[str](maxlen=40)
        self._lock = asyncio.Lock()
        self._target = 0
        self._restarting = False
        self.chunk_times = collections.deque[float](maxlen=100)
        self.recent = collections.deque[bytes](maxlen=1000 // CHUNK_MS)
        self.chunks_total = 0
        self.started_at = 0.0
        self.last_error: str | None = None

    @property
    def enabled(self) -> bool:
        return bool(getattr(self._get_settings(), "audio_enabled", True))

    def unavailable_reason(self) -> str | None:
        if shutil.which("gst-launch-1.0") is None:
            return "gst-launch-1.0 not found on this OS image"
        if not os.path.exists(os.path.join(_user_runtime_dir(), "pipewire-0")):
            return f"PipeWire socket not found in {_user_runtime_dir()} (is the user session running?)"
        return None

    @property
    def running(self) -> bool:
        return self._proc is not None and self._proc.returncode is None

    def _pipeline(self) -> list[str]:
        target = TARGETS[self._target]
        # WirePlumber 0.5 spells it stream.capture.sink; a capture stream without it never finds a sink.
        src = ["pipewiresrc", "stream-properties=props,stream.capture.sink=true,node.name=decky-mcp-audio"]
        if target:
            src.insert(1, f"target-object={target}")
        return [
            "gst-launch-1.0", "-q", *src,
            "!", "audioconvert", "!", "audioresample",
            "!", f"audio/x-raw,format=S16LE,rate={RATE},channels={CHANNELS},layout=interleaved",
            "!", "fdsink", "fd=1", "sync=false",
        ]

    def _env(self) -> dict[str, str]:
        env = {k: v for k, v in os.environ.items() if k != "LD_LIBRARY_PATH"}
        env["XDG_RUNTIME_DIR"] = _user_runtime_dir()
        env.setdefault("PATH", "/usr/local/bin:/usr/bin:/bin")
        return env

    async def _spawn(self) -> asyncio.subprocess.Process:
        return await asyncio.create_subprocess_exec(
            *self._pipeline(), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, env=self._env(),
        )

    async def start(self) -> None:
        async with self._lock:
            if self.running:
                return
            if not self.enabled:
                raise AudioDisabled("audio is disabled")
            reason = self.unavailable_reason()
            if reason:
                self.last_error = reason
                raise AudioUnavailable(reason)
            self._stderr.clear()
            self._proc = await self._spawn()
            self.started_at = time.monotonic()
            self.chunks_total = 0
            self.chunk_times.clear()
            self.recent.clear()
            self.last_error = None
            self._reader_task = asyncio.create_task(self._read_loop(self._proc))
            asyncio.create_task(self._drain_stderr(self._proc))
            self.log.info("audio capture started: %s", " ".join(self._pipeline()))

    async def stop(self) -> None:
        async with self._lock:
            proc, self._proc = self._proc, None
            reader, self._reader_task = self._reader_task, None
            if proc and proc.returncode is None:
                # SIGINT like the video pipeline: gst-launch deactivates its PipeWire stream first.
                proc.send_signal(signal.SIGINT)
                try:
                    await asyncio.wait_for(proc.wait(), 2)
                except asyncio.TimeoutError:
                    proc.kill()
                    await proc.wait()
            if reader:
                reader.cancel()
            if not self._restarting:
                self._target = 0
            if proc:
                self.log.info("audio capture stopped")

    async def apply_enabled(self) -> None:
        """Call after audio_enabled changed: disabling ends every subscriber and stops the pipeline."""
        if self.enabled:
            return
        for q in self._subs:
            self._put(q, _DISABLED)
        await self.stop()

    async def _drain_stderr(self, proc: asyncio.subprocess.Process) -> None:
        assert proc.stderr is not None
        async for raw in proc.stderr:
            self._stderr.append(raw.decode(errors="replace").rstrip())

    async def _read_loop(self, proc: asyncio.subprocess.Process) -> None:
        reader = proc.stdout
        assert reader is not None
        try:
            while True:
                self._publish(await reader.readexactly(CHUNK_BYTES))
        except (asyncio.IncompleteReadError, asyncio.CancelledError):
            pass
        finally:
            if proc is self._proc:  # ended on its own rather than via stop()
                self._proc = None
                code = await proc.wait()
                tail = "\n".join(list(self._stderr)[-5:])
                self.last_error = f"audio pipeline exited (code {code}). {tail}".strip()
                self.log.warning(self.last_error)
                if self.chunks_total == 0 and "target not found" in tail and self._target + 1 < len(TARGETS) and self._subs:
                    self._target += 1
                    self.log.info("audio: falling back to sink %s", TARGETS[self._target])
                    self._restarting = True
                    try:
                        await self.start()
                    except (AudioUnavailable, AudioDisabled):
                        pass
                    finally:
                        self._restarting = False

    @staticmethod
    def _put(q: asyncio.Queue, item) -> None:
        if q.full():
            try:
                q.get_nowait()  # slow consumer: drop the oldest chunk so playback never lags behind
            except asyncio.QueueEmpty:
                pass
        q.put_nowait(item)

    def _publish(self, chunk: bytes) -> None:
        self.chunks_total += 1
        self.chunk_times.append(time.monotonic())
        self.recent.append(chunk)
        for q in self._subs:
            self._put(q, chunk)

    async def subscribe(self) -> AsyncIterator[bytes]:
        if not self.enabled:
            raise AudioDisabled("audio is disabled")
        q: asyncio.Queue = asyncio.Queue(maxsize=MAX_BACKLOG_CHUNKS)
        self._subs.add(q)
        if self._idle_task:
            self._idle_task.cancel()
            self._idle_task = None
        try:
            await self.start()
            while True:
                if not self.running and not self._restarting:
                    raise AudioUnavailable(self.last_error or "audio pipeline is not running")
                try:
                    item = await asyncio.wait_for(q.get(), 5)
                except asyncio.TimeoutError:
                    continue
                if item is _DISABLED:
                    raise AudioDisabled("audio was disabled")
                yield item
        finally:
            self._subs.discard(q)
            if not self._subs:
                self._idle_task = asyncio.create_task(self._stop_when_idle())

    async def _stop_when_idle(self) -> None:
        await asyncio.sleep(self.idle_stop)
        if not self._subs:
            await self.stop()

    def rms_db(self) -> float | None:
        chunks = list(self.recent)[-1000 // CHUNK_MS:]
        if not chunks:
            return None
        samples = array.array("h", b"".join(chunks))
        if sys.byteorder == "big":
            samples.byteswap()
        # Every 4th sample is plenty for a level readout and keeps this cheap.
        sub = samples[::4]
        mean = sum(x * x for x in sub) / len(sub)
        return round(20 * math.log10(math.sqrt(mean) / 32768), 1) if mean > 0 else -120.0

    def stats(self) -> dict[str, object]:
        now = time.monotonic()
        recent = sum(1 for t in self.chunk_times if now - t <= 2.0)
        return {
            "enabled": self.enabled,
            "available": self.unavailable_reason() is None,
            "running": self.running,
            "subscribers": len(self._subs),
            "kbps": round(recent * CHUNK_BYTES * 8 / 2.0 / 1000),
            "chunks_total": self.chunks_total,
            "rms_db": self.rms_db() if self.running else None,
            "uptime_s": round(now - self.started_at, 1) if self.running else 0,
            "source": TARGETS[self._target] or "default sink",
            "format": {k: v for k, v in FORMAT.items() if k != "type"},
            "error": self.last_error,
        }
