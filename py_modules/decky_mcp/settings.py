import json
import os
import secrets
from dataclasses import asdict, dataclass, field

DEFAULT_PORT = 8765
STREAM_LIMITS = {"fps": [1, 60], "quality": [10, 100], "widths": [0, 1600, 1280, 960, 640]}
MAX_STREAM_WIDTH = 3840


@dataclass
class Settings:
    enabled: bool = True
    bind: str = "0.0.0.0"
    port: int = DEFAULT_PORT
    token: str = field(default_factory=lambda: secrets.token_urlsafe(32))
    stream_fps: int = 30
    stream_quality: int = 70
    stream_width: int = 0  # 0 = native resolution
    input_enabled: bool = False

    @classmethod
    def load(cls, settings_dir: str) -> "Settings":
        path = os.path.join(settings_dir, "settings.json")
        try:
            with open(path) as f:
                data = json.load(f)
            return cls(**{k: v for k, v in data.items() if k in cls.__dataclass_fields__})
        except (FileNotFoundError, json.JSONDecodeError, TypeError):
            s = cls()
            s.save(settings_dir)
            return s

    def save(self, settings_dir: str) -> None:
        os.makedirs(settings_dir, exist_ok=True)
        path = os.path.join(settings_dir, "settings.json")
        tmp = path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(asdict(self), f, indent=2)
        # The token is a credential: keep the file owner-only readable.
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)

    def stream_settings(self) -> dict:
        return {"fps": self.stream_fps, "quality": self.stream_quality, "width": self.stream_width}

    def update_stream(self, fps=None, quality=None, width=None) -> bool:
        """Validate and clamp the given stream settings into place; returns whether anything changed."""
        before = self.stream_settings()
        # Parse everything first so a bad field leaves the settings untouched.
        fps, quality, width = (None if v is None else _as_int(n, v) for n, v in (("fps", fps), ("quality", quality), ("width", width)))
        if fps is not None:
            self.stream_fps = max(STREAM_LIMITS["fps"][0], min(STREAM_LIMITS["fps"][1], fps))
        if quality is not None:
            self.stream_quality = max(STREAM_LIMITS["quality"][0], min(STREAM_LIMITS["quality"][1], quality))
        if width is not None:
            self.stream_width = max(0, min(MAX_STREAM_WIDTH, width))
        return self.stream_settings() != before

    def update_input(self, enabled) -> bool:
        """Set input_enabled (strict bool); returns whether it changed."""
        if not isinstance(enabled, bool):
            raise ValueError("enabled must be true or false")
        changed = self.input_enabled != enabled
        self.input_enabled = enabled
        return changed


def _as_int(name: str, value) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        raise ValueError(f"{name} must be an integer")
    try:
        return int(value)
    except (ValueError, OverflowError):
        raise ValueError(f"{name} must be an integer") from None
