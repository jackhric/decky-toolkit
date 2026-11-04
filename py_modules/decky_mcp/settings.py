import json
import os
import secrets
from dataclasses import asdict, dataclass, field

DEFAULT_PORT = 8765


@dataclass
class Settings:
    enabled: bool = True
    bind: str = "0.0.0.0"
    port: int = DEFAULT_PORT
    token: str = field(default_factory=lambda: secrets.token_urlsafe(32))
    stream_fps: int = 30
    stream_quality: int = 70
    stream_width: int = 0  # 0 = native resolution

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
