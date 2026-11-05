"""Non-secret device identification for the public `/health` route (network discovery)."""
import functools
import hashlib
import socket
from pathlib import Path

MACHINE_ID = Path("/etc/machine-id")
OS_RELEASE = Path("/etc/os-release")


def device_id(machine_id_path: Path = MACHINE_ID) -> str | None:
    # Hashed with a namespace so the raw machine-id (which other software treats as confidential)
    # never leaves the device; the result is only stable, not reversible.
    try:
        raw = machine_id_path.read_text().strip()
    except OSError:
        return None
    if not raw:
        return None
    return hashlib.sha256(f"decky-toolkit:{raw}".encode()).hexdigest()[:16]


def os_name(os_release_path: Path = OS_RELEASE) -> str | None:
    try:
        lines = os_release_path.read_text().splitlines()
    except OSError:
        return None
    fields = {}
    for line in lines:
        key, sep, value = line.partition("=")
        if sep:
            fields[key.strip()] = value.strip().strip('"\'')
    return fields.get("PRETTY_NAME") or fields.get("NAME") or None


@functools.cache
def identity() -> dict:
    return {"hostname": socket.gethostname(), "device_id": device_id(), "os": os_name()}
