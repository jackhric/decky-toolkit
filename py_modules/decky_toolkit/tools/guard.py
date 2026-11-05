"""Paths file tools must not touch. Every tool that reads or writes arbitrary device paths calls
check_read/check_write (the server runs as root, so nothing else stands in the way)."""
import fnmatch
import os

# Steam login/session material: copying these moves a Steam login to another machine.
SENSITIVE_PATTERNS = (
    "*/config/loginusers.vdf",
    "*/config/config.vdf",
    "*/ssfn*",
    "*/local.vdf",
    "*/htmlcache/*cookies*",
    "*/.ssh/id_*",
    "/etc/shadow",
    "/etc/gshadow",
)
# Readable, but a bad write breaks Steam's library or login.
WRITE_PROTECTED_PATTERNS = SENSITIVE_PATTERNS + (
    "*/config/libraryfolders.vdf",
    "*/steamapps/libraryfolders.vdf",
)


def _candidates(path: str) -> set[str]:
    expanded = os.path.expanduser(path)
    # Check the resolved path too, so a symlink cannot launder a denied file.
    return {os.path.normpath(expanded).lower(), os.path.realpath(expanded).lower()}


def _matches(path: str, patterns: tuple[str, ...]) -> bool:
    for p in _candidates(path):
        if p.endswith(".pub"):
            continue
        if any(fnmatch.fnmatchcase(p, pat) for pat in patterns):
            return True
    return False


def is_sensitive(path: str) -> bool:
    """Credential or session files that may be neither read nor written."""
    return _matches(path, SENSITIVE_PATTERNS)


def is_write_protected(path: str) -> bool:
    return _matches(path, WRITE_PROTECTED_PATTERNS)


def check_read(path: str) -> None:
    if is_sensitive(path):
        raise PermissionError(f"refusing to read {path}: Steam credential/session or key file (tools/guard.py)")


def check_write(path: str) -> None:
    if is_write_protected(path):
        raise PermissionError(f"refusing to write {path}: protected Steam config, credential or key file (tools/guard.py)")
