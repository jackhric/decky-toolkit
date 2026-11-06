"""Screen recording: Matroska writer, recorder limits and recording_list. Run with: ./scripts/test.sh"""
import asyncio
import json
import logging
import shutil
import struct
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "py_modules"))

from decky_toolkit.media import record as record_mod  # noqa: E402
from decky_toolkit.media.capture import CaptureUnavailable  # noqa: E402
from decky_toolkit.media.record import MkvWriter, Recorder, RecordingBusy, check_name, recorder_for  # noqa: E402

from decky_toolkit.tools import build_registry  # noqa: E402

LOG = logging.getLogger("t")
JPEG = (Path(__file__).parent / "fixtures" / "tiny.jpg").read_bytes()
PCM = b"\x01\x00" * 1920  # one 20 ms stereo chunk


class FakeAudio:
    def __init__(self, enabled: bool = True) -> None:
        self.enabled = enabled
        self.subscribed = 0

    def unavailable_reason(self):
        return None

    async def subscribe(self):
        self.subscribed += 1
        while True:
            await asyncio.sleep(0.02)
            yield PCM


class FakeCapturer:
    def __init__(self, fps: int = 30, audio: FakeAudio | None = None, frames: bool = True) -> None:
        self.fps = fps
        self.audio = audio
        self.frames = frames
        self.log = LOG
        self.subs = 0
        self.active = 0

    def _get_settings(self):
        return SimpleNamespace(stream_fps=self.fps)

    def unavailable_reason(self):
        return None

    async def subscribe(self, tick: bool = False):
        self.subs += 1
        self.active += 1
        try:
            while True:
                await asyncio.sleep(1 / self.fps)
                if self.frames:
                    yield JPEG
        finally:
            self.active -= 1


@pytest.fixture
def runtime(tmp_path, monkeypatch):
    monkeypatch.setenv("DECKY_PLUGIN_RUNTIME_DIR", str(tmp_path))
    monkeypatch.setattr(record_mod, "MIN_FREE_BYTES", 0)
    return tmp_path


# ---- a minimal EBML reader for checking the writer's output ----

def read_vint(buf: bytes, i: int, keep_marker: bool) -> tuple[int, int]:
    length = 1
    while not buf[i] & (0x80 >> (length - 1)):
        length += 1
    val = int.from_bytes(buf[i:i + length], "big")
    if not keep_marker:
        val &= (1 << (7 * length)) - 1
    return val, i + length


def elements(buf: bytes, start: int = 0, end: int | None = None):
    i, end = start, len(buf) if end is None else end
    while i < end:
        eid, j = read_vint(buf, i, keep_marker=True)
        size, k = read_vint(buf, j, keep_marker=False)
        yield eid, k, size
        i = k + size


def child(buf: bytes, start: int, size: int, eid: int):
    return [(k, s) for e, k, s in elements(buf, start, start + size) if e == eid]


def write_sample(path: Path, audio: bool = True) -> None:
    with open(path, "wb") as f:
        w = MkvWriter(f, 16, 16, audio)
        for n in range(90):  # 3 s at 30 fps, so there are several clusters
            w.add_video(n * 1000 / 30, JPEG)
            if audio and n % 2 == 0:
                for k in range(3):
                    w.add_audio(n * 1000 / 30 + k * 20 - 5, PCM)
        w.close(3000)


def test_mkv_structure(tmp_path):
    p = tmp_path / "a.mkv"
    write_sample(p)
    buf = p.read_bytes()
    top = list(elements(buf))
    assert [e for e, _, _ in top] == [0x1A45DFA3, 0x18538067]
    _, seg, seg_size = top[1]
    assert seg + seg_size == len(buf), "segment size patched to the real length"
    kids = {e: (k, s) for e, k, s in elements(buf, seg, seg + seg_size)}
    assert {0x114D9B74, 0x1549A966, 0x1654AE6B, 0x1F43B675, 0x1C53BB6B} <= set(kids)
    k, s = kids[0x1549A966]
    (dk, ds), = child(buf, k, s, 0x4489)
    assert struct.unpack(">d", buf[dk:dk + ds])[0] == 3000.0
    k, s = kids[0x1654AE6B]
    assert len(child(buf, k, s, 0xAE)) == 2
    seeks = child(buf, *kids[0x114D9B74], 0x4DBB)
    positions = {}
    for sk, ss in seeks:
        (ik, isz), = child(buf, sk, ss, 0x53AB)
        (pk, psz), = child(buf, sk, ss, 0x53AC)
        positions[int.from_bytes(buf[ik:ik + isz], "big")] = int.from_bytes(buf[pk:pk + psz], "big")
    for eid in (0x1549A966, 0x1654AE6B, 0x1C53BB6B):
        assert buf[seg + positions[eid]:seg + positions[eid] + 4] == eid.to_bytes(4, "big")
    clusters = [(k, s) for e, k, s in elements(buf, seg, seg + seg_size) if e == 0x1F43B675]
    assert len(clusters) >= 3
    blocks = [buf[bk] & 0x7F for ck, cs in clusters for bk, _ in child(buf, ck, cs, 0xA3)]
    assert blocks.count(1) == 90 and blocks.count(2) == 135
    assert len(child(buf, *kids[0x1C53BB6B], 0xBB)) == len(clusters)


@pytest.mark.skipif(shutil.which("ffprobe") is None, reason="ffprobe not installed")
def test_mkv_plays_in_ffmpeg(tmp_path):
    p = tmp_path / "b.mkv"
    write_sample(p)
    out = subprocess.run(["ffprobe", "-v", "error", "-count_frames", "-show_entries",
                          "format=duration:stream=codec_name,nb_read_frames,sample_rate,channels", "-of", "json", str(p)],
                         capture_output=True, text=True, check=True)
    info = json.loads(out.stdout)
    codecs = {s["codec_name"]: s for s in info["streams"]}
    assert set(codecs) == {"mjpeg", "pcm_s16le"}
    assert codecs["mjpeg"]["nb_read_frames"] == "90"
    assert codecs["pcm_s16le"]["sample_rate"] == "48000" and codecs["pcm_s16le"]["channels"] == 2
    assert abs(float(info["format"]["duration"]) - 3.0) < 0.1
    dec = subprocess.run(["ffmpeg", "-v", "error", "-i", str(p), "-f", "null", "-"], capture_output=True, text=True)
    assert dec.returncode == 0 and not dec.stderr.strip()


def test_check_name():
    assert check_name("clip_1.a") == "clip_1.a"
    assert check_name("clip.mkv") == "clip"
    for bad in ("", "../x", "a/b", ".hidden", "x" * 65, "a b", 5):
        with pytest.raises(ValueError):
            check_name(bad)


def test_record_limits(runtime):
    rec = Recorder(FakeCapturer())

    async def run():
        for bad in (0, -1, 121, True, "5"):
            with pytest.raises(ValueError):
                await rec.record(seconds=bad)
        for bad in (0, 61, 2.5, True):
            with pytest.raises(ValueError):
                await rec.record(seconds=1, fps=bad)
        with pytest.raises(ValueError):
            await rec.record(seconds=1, with_audio="yes")
        with pytest.raises(ValueError):
            await rec.record(seconds=1, name="../etc")
    asyncio.run(run())
    assert not list((runtime / "recordings").glob("*")) if (runtime / "recordings").exists() else True


def test_record_with_audio_list_and_delete(runtime):
    audio = FakeAudio()
    cap = FakeCapturer(fps=30, audio=audio)
    rec = Recorder(cap)

    async def run():
        res = await rec.record(seconds=0.6, name="clip")
        assert cap.active == 0 and audio.subscribed == 1, "subscriptions released"
        return res
    res = asyncio.run(run())
    path = runtime / "recordings" / "clip.mkv"
    assert res["path"] == str(path) and path.is_file() and not (runtime / "recordings" / "clip.mkv.part").exists()
    assert res["audio"] is True and res["audio_chunks"] > 10
    assert 10 <= res["frames"] <= 22 and 0.5 <= res["duration_s"] <= 1.0
    assert res["size"] == path.stat().st_size
    listing = rec.list()
    assert [r["name"] for r in listing["recordings"]] == ["clip"] and listing["active"] is None
    with pytest.raises(ValueError):
        asyncio.run(rec.record(seconds=0.2, name="clip"))  # exists
    with pytest.raises(ValueError):
        rec.delete("clip")
    with pytest.raises(FileNotFoundError):
        rec.delete("nope", confirm=True)
    assert rec.delete("clip", confirm=True)["deleted"] == str(path)
    assert not path.exists()


def test_record_fps_cap_and_downsample(runtime):
    rec = Recorder(FakeCapturer(fps=30))
    res = asyncio.run(rec.record(seconds=1.0, fps=10, with_audio=True, name="slow"))
    assert res["audio"] is False and "audio skipped" in res["audio_note"]
    assert 8 <= res["frames"] <= 12
    assert rec.active is None


def test_record_audio_disabled(runtime):
    rec = Recorder(FakeCapturer(audio=FakeAudio(enabled=False)))
    res = asyncio.run(rec.record(seconds=0.3, name="quiet"))
    assert res["audio"] is False and "disabled" in res["audio_note"]


def test_record_one_at_a_time_and_stop(runtime):
    rec = Recorder(FakeCapturer())

    async def run():
        started = await rec.record(seconds=30, name="long", wait=False)
        assert started["recording"] and rec.list()["active"]["name"] == "long"
        with pytest.raises(RecordingBusy):
            await rec.record(seconds=1, name="other")
        await asyncio.sleep(0.3)
        res = await rec.stop()
        assert res["duration_s"] < 2 and (runtime / "recordings" / "long.mkv").is_file()
        assert await rec.stop() == {"recording": False}
    asyncio.run(run())


def test_record_no_frames_cleans_up(runtime, monkeypatch):
    monkeypatch.setattr(record_mod, "FIRST_FRAME_TIMEOUT", 0.3)
    cap = FakeCapturer(frames=False)
    rec = Recorder(cap)

    async def run():
        with pytest.raises(CaptureUnavailable):
            await rec.record(seconds=1, name="empty")
        await asyncio.sleep(0)
        assert cap.active == 0
    asyncio.run(run())
    assert list((runtime / "recordings").iterdir()) == []
    assert "error" in rec.list()["last"]


def test_recording_list_tool(runtime):
    cap = FakeCapturer()
    asyncio.run(recorder_for(cap).record(seconds=0.3, name="dl"))
    res = asyncio.run(build_registry(cap).call("recording_list", {}))
    assert [x["name"] for x in json.loads(res["content"][0]["text"])["recordings"]] == ["dl"]
