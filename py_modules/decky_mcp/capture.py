"""Full-display capture: gamescope's PipeWire video node -> GStreamer -> JPEG frames.

The GStreamer pipeline runs as a subprocess and writes a multipart/x-mixed-replace stream to its
stdout; we parse it into frames and fan them out to any number of subscribers (browser viewers and
MCP tool calls). The pipeline only runs while someone is consuming frames.
"""
import asyncio
import collections
import os
import pwd
import shutil
import signal
import time
from typing import Any, AsyncIterator, Callable

from .settings import STREAM_LIMITS, Settings

IDLE_STOP_SECONDS = 10
BOUNDARY = b"frame"
# gamescope resends nothing on its own; pipewiresrc re-emits the last buffer at this interval so a
# static screen still yields frames, and videorate fills to the target rate.
KEEPALIVE_MS = 100
# Bound how far videorate will backfill after a stall, so a long gap never becomes a frame burst.
MAX_DUPLICATION_NS = 1_000_000_000


class CaptureUnavailable(RuntimeError):
    pass


def _user_runtime_dir() -> str:
    user = os.environ.get("DECKY_USER", "deck")
    try:
        uid = pwd.getpwnam(user).pw_uid
    except KeyError:
        uid = 1000
    return f"/run/user/{uid}"


def jpeg_size(data: bytes) -> tuple[int, int] | None:
    # Walk the marker segments to the SOF header; no decoder needed.
    i = 2
    n = len(data)
    while i + 9 < n and data[i] == 0xFF:
        marker = data[i + 1]
        if marker in (0xC0, 0xC1, 0xC2):
            return int.from_bytes(data[i + 7:i + 9], "big"), int.from_bytes(data[i + 5:i + 7], "big")
        if marker == 0xD8 or 0xD0 <= marker <= 0xD7:
            i += 2
            continue
        i += 2 + int.from_bytes(data[i + 2:i + 4], "big")
    return None


class ScreenCapturer:
    def __init__(self, get_settings: Callable[[], Settings], logger, save_settings: Callable[[], None] | None = None) -> None:
        self._get_settings = get_settings
        self._save_settings = save_settings
        self._restarting = False
        self.log = logger
        self._proc: asyncio.subprocess.Process | None = None
        self._reader_task: asyncio.Task[None] | None = None
        self._idle_task: asyncio.Task[None] | None = None
        self._subs: set[asyncio.Queue[bytes]] = set()
        self._stderr = collections.deque[str](maxlen=40)
        self._lock = asyncio.Lock()
        self.latest: bytes | None = None
        self.latest_at = 0.0
        self.frame_times = collections.deque[float](maxlen=120)
        self.frame_bytes = collections.deque[int](maxlen=120)
        self.frames_total = 0
        self.started_at = 0.0
        self.last_error: str | None = None

    # ---- availability ----

    def unavailable_reason(self) -> str | None:
        if shutil.which("gst-launch-1.0") is None:
            return "gst-launch-1.0 not found on this OS image"
        if not os.path.exists(os.path.join(_user_runtime_dir(), "pipewire-0")):
            return f"PipeWire socket not found in {_user_runtime_dir()} (is the user session running?)"
        return None

    @property
    def running(self) -> bool:
        return self._proc is not None and self._proc.returncode is None

    # ---- pipeline ----

    def _pipeline(self) -> list[str]:
        s = self._get_settings()
        fps = max(1, min(60, int(getattr(s, "stream_fps", 30))))
        quality = max(10, min(100, int(getattr(s, "stream_quality", 70))))
        width = int(getattr(s, "stream_width", 0) or 0)
        # gamescope advertises pixel-aspect-ratio=1/2147483647, which makes videoscale derive a height of 1
        # (or keep 1080 if the output PAR is left open), so declare square pixels before scaling.
        scale = [
            "!", "capssetter", "caps=video/x-raw,pixel-aspect-ratio=1/1",
            "!", "videoscale", "!", f"video/x-raw,width={width},pixel-aspect-ratio=1/1",
        ] if width > 0 else []
        return [
            "gst-launch-1.0", "-q",
            "pipewiresrc", "target-object=gamescope", "do-timestamp=true", f"keepalive-time={KEEPALIVE_MS}",
            "!", "video/x-raw",
            "!", "videoconvert", "n-threads=4",
            *scale,
            # skip-to-first: otherwise videorate backfills from t=0 to the first frame with duplicates,
            # which after a slow start (e.g. the Steam UI reloading) arrives as a burst of hundreds.
            "!", "videorate", "skip-to-first=true", f"max-duplication-time={MAX_DUPLICATION_NS}",
            "!", f"video/x-raw,framerate={fps}/1",
            "!", "jpegenc", f"quality={quality}",
            "!", "multipartmux", f"boundary={BOUNDARY.decode()}",
            "!", "fdsink", "fd=1", "sync=false",
        ]

    def _env(self) -> dict[str, str]:
        env = {k: v for k, v in os.environ.items() if k != "LD_LIBRARY_PATH"}
        # The plugin runs as root; PipeWire lives in the desktop user's session.
        env["XDG_RUNTIME_DIR"] = _user_runtime_dir()
        env.setdefault("PATH", "/usr/local/bin:/usr/bin:/bin")
        return env

    async def start(self) -> None:
        async with self._lock:
            if self.running:
                return
            reason = self.unavailable_reason()
            if reason:
                self.last_error = reason
                raise CaptureUnavailable(reason)
            self._stderr.clear()
            self._proc = await asyncio.create_subprocess_exec(
                *self._pipeline(), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, env=self._env(),
                limit=1 << 20,
            )
            self.started_at = time.monotonic()
            self.frames_total = 0
            self.frame_times.clear()
            self.frame_bytes.clear()
            self.last_error = None
            self._reader_task = asyncio.create_task(self._read_loop(self._proc))
            asyncio.create_task(self._drain_stderr(self._proc))
            asyncio.create_task(self._seed(self._proc))
            self.log.info("screen capture started: %s", " ".join(self._pipeline()))

    async def stop(self) -> None:
        async with self._lock:
            proc, self._proc = self._proc, None
            reader, self._reader_task = self._reader_task, None
            if proc and proc.returncode is None:
                # SIGINT makes gst-launch take the pipeline down through PAUSED, which deactivates the
                # PipeWire stream before disconnecting. Killing it while gamescope paints into its
                # buffers crashes gamescope (SIGSEGV in paint_pipewire, 3.16.31, 2026-11-04). Keep
                # reading stdout meanwhile so a full pipe cannot stall the shutdown.
                proc.send_signal(signal.SIGINT)
                try:
                    await asyncio.wait_for(proc.wait(), 2)
                except asyncio.TimeoutError:
                    proc.kill()
                    await proc.wait()
            if reader:
                reader.cancel()
            if proc:
                self.log.info("screen capture stopped")

    async def restart(self) -> None:
        # Subscribers wait through the gap instead of ending, so viewers just see a short pause.
        self._restarting = True
        try:
            await self.stop()
            if self._subs:
                await self.start()
        finally:
            self._restarting = False

    def stream_settings(self) -> dict[str, Any]:
        return {**self._get_settings().stream_settings(), "limits": STREAM_LIMITS}

    async def update_settings(self, fps: Any = None, quality: Any = None, width: Any = None) -> dict[str, Any]:
        """Validate, persist and apply stream settings. Raises ValueError on non-integer input."""
        if self._get_settings().update_stream(fps, quality, width):
            if self._save_settings:
                self._save_settings()
            if self.running:
                try:
                    await self.restart()
                except CaptureUnavailable as e:
                    self.log.warning("capture restart failed: %s", e)
        return self.stream_settings()

    async def _seed(self, proc: asyncio.subprocess.Process) -> None:
        # gamescope only pushes a PipeWire frame when it repaints, so a fresh consumer on a static
        # screen would wait forever. Ask gamescope to repaint until the first frame lands; after that
        # keepalive-time sustains the stream.
        for attempt, nudge in enumerate((self._nudge_repaint, self._nudge_screenshot, self._nudge_repaint)):
            await asyncio.sleep(0.3 if attempt == 0 else 0.7)
            if proc is not self._proc or self.frames_total > 0:
                return
            await nudge()
        await asyncio.sleep(1.0)
        if proc is self._proc and self.frames_total == 0:
            self.log.warning("no frame from gamescope after nudging; the stream will start on the next screen change")

    async def _gamescopectl(self, *args: str) -> None:
        env = self._env()
        for display in (":1", ":0"):
            env["DISPLAY"] = display
            try:
                proc = await asyncio.create_subprocess_exec(
                    "gamescopectl", *args, env=env, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
                )
                if await asyncio.wait_for(proc.wait(), 3) == 0:
                    return
            except (FileNotFoundError, asyncio.TimeoutError):
                return

    async def _nudge_repaint(self) -> None:
        await self._gamescopectl("debug_force_repaint")

    async def _nudge_screenshot(self) -> None:
        path = os.path.join(os.environ.get("DECKY_PLUGIN_RUNTIME_DIR", "/tmp"), "nudge.png")
        await self._gamescopectl("screenshot", path)
        await asyncio.sleep(0.3)
        try:
            os.remove(path)
        except OSError:
            pass

    async def _drain_stderr(self, proc: asyncio.subprocess.Process) -> None:
        assert proc.stderr is not None
        async for raw in proc.stderr:
            self._stderr.append(raw.decode(errors="replace").rstrip())

    async def _read_loop(self, proc: asyncio.subprocess.Process) -> None:
        reader = proc.stdout
        assert reader is not None
        try:
            while True:
                line = await reader.readline()
                if not line:
                    break
                if not line.startswith(b"--" + BOUNDARY):
                    continue
                length = 0
                while True:
                    header = await reader.readline()
                    if header in (b"\r\n", b"\n", b""):
                        break
                    name, _, value = header.decode(errors="replace").partition(":")
                    if name.strip().lower() == "content-length":
                        length = int(value.strip())
                if length <= 0:
                    continue
                self._publish(await reader.readexactly(length))
        except (asyncio.IncompleteReadError, asyncio.CancelledError):
            pass
        except ValueError as e:  # a "line" longer than the reader limit means we lost multipart sync
            self.log.error("capture stream desync: %s", e)
        finally:
            if proc is self._proc:  # ended on its own rather than via stop()
                self._proc = None
                if proc.returncode is None:
                    proc.terminate()
                code = await proc.wait()
                tail = "\n".join(list(self._stderr)[-5:])
                self.last_error = f"capture pipeline exited (code {code}). {tail}".strip()
                self.log.warning(self.last_error)

    def _publish(self, frame: bytes) -> None:
        now = time.monotonic()
        self.latest = frame
        self.latest_at = now
        self.frames_total += 1
        self.frame_times.append(now)
        self.frame_bytes.append(len(frame))
        for q in self._subs:
            if q.full():
                try:
                    q.get_nowait()  # slow consumer: drop its stale frame, always deliver the newest
                except asyncio.QueueEmpty:
                    pass
            q.put_nowait(frame)

    # ---- consumers ----

    async def subscribe(self) -> AsyncIterator[bytes]:
        q: asyncio.Queue[bytes] = asyncio.Queue(maxsize=2)
        self._subs.add(q)
        if self._idle_task:
            self._idle_task.cancel()
            self._idle_task = None
        try:
            await self.start()
            if self.latest is not None and time.monotonic() - self.latest_at < 1.0:
                yield self.latest  # instant first frame for late joiners
            while True:
                if not self.running and not self._restarting:
                    raise CaptureUnavailable(self.last_error or "capture pipeline is not running")
                try:
                    yield await asyncio.wait_for(q.get(), 5)
                except asyncio.TimeoutError:
                    continue
        finally:
            self._subs.discard(q)
            if not self._subs:
                self._idle_task = asyncio.create_task(self._stop_when_idle())

    async def _stop_when_idle(self) -> None:
        await asyncio.sleep(IDLE_STOP_SECONDS)
        if not self._subs:
            await self.stop()

    async def grab(self, timeout: float = 8.0) -> bytes:
        """Return one current frame, starting the pipeline if needed."""
        agen = self.subscribe()
        try:
            return await asyncio.wait_for(agen.__anext__(), timeout)
        except StopAsyncIteration:
            raise CaptureUnavailable(self.last_error or "capture ended") from None
        except asyncio.TimeoutError:
            raise CaptureUnavailable(self.last_error or f"no frame within {timeout}s; gamescope did not repaint") from None
        finally:
            await agen.aclose()

    def stats(self) -> dict[str, object]:
        now = time.monotonic()
        recent = [t for t in self.frame_times if now - t <= 2.0]
        fps = len(recent) / 2.0 if recent else 0.0
        recent_bytes = list(self.frame_bytes)[-len(recent):] if recent else []
        size = jpeg_size(self.latest) if self.latest else None
        return {
            "available": self.unavailable_reason() is None,
            "running": self.running,
            "subscribers": len(self._subs),
            "fps": round(fps, 1),
            "kbps": round(sum(recent_bytes) * 8 / 2.0 / 1000) if recent_bytes else 0,
            "frames_total": self.frames_total,
            "uptime_s": round(now - self.started_at, 1) if self.running else 0,
            "width": size[0] if size else None,
            "height": size[1] if size else None,
            "settings": self._get_settings().stream_settings(),
            "limits": STREAM_LIMITS,
            "error": self.last_error,
        }
