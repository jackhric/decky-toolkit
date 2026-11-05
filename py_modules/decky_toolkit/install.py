"""Validate a Decky plugin zip and install it into the plugins directory atomically."""
import io
import json
import logging
import os
import shutil
import stat
import tempfile
import zipfile
from typing import Any

REQUIRED_FIELDS: dict[str, type] = {"name": str, "author": str, "flags": list, "api_version": int}


def _segments(name: str) -> list[str]:
    return [s for s in name.replace("\\", "/").split("/") if s not in ("", ".")]


def _check_member(info: zipfile.ZipInfo) -> None:
    name = info.filename
    if name.startswith(("/", "\\")) or (len(name) > 1 and name[1] == ":"):
        raise ValueError(f"absolute path in zip: {name!r}")
    if ".." in _segments(name):
        raise ValueError(f"path traversal in zip: {name!r}")
    if stat.S_ISLNK(info.external_attr >> 16):
        raise ValueError(f"symlink in zip: {name!r}")


def _read_json(zf: zipfile.ZipFile, info: zipfile.ZipInfo) -> Any:
    try:
        return json.loads(zf.read(info))
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        raise ValueError(f"{info.filename} is not valid JSON: {e}") from None


def inspect_zip(zf: zipfile.ZipFile) -> tuple[str | None, dict[str, Any], str | None]:
    """Return (top-level dir, or None for a root layout; plugin.json; package.json version)."""
    infos = zf.infolist()
    for info in infos:
        _check_member(info)
    by_path = {"/".join(_segments(i.filename)): i for i in infos}
    by_path.pop("", None)
    tops = {p.split("/", 1)[0] for p in by_path}
    if "plugin.json" in by_path:
        top = None
    elif len(tops) == 1 and f"{next(iter(tops))}/plugin.json" in by_path:
        top = next(iter(tops))
    else:
        raise ValueError("plugin.json not found at the zip root or inside a single top-level directory")
    prefix = f"{top}/" if top else ""
    meta = _read_json(zf, by_path[prefix + "plugin.json"])
    if not isinstance(meta, dict):
        raise ValueError("plugin.json must be an object")
    for field, typ in REQUIRED_FIELDS.items():
        value = meta.get(field)
        # bool is an int subclass; "api_version": true is not a version.
        if not isinstance(value, typ) or isinstance(value, bool):
            raise ValueError(f"plugin.json: '{field}' must be a {typ.__name__}")
    version = None
    if prefix + "package.json" in by_path:
        pkg = _read_json(zf, by_path[prefix + "package.json"])
        if isinstance(pkg, dict) and isinstance(pkg.get("version"), str):
            version = pkg["version"]
    return top, meta, version


def _extract(zf: zipfile.ZipFile, top: str | None, dest: str) -> None:
    os.mkdir(dest)
    for info in zf.infolist():
        parts = _segments(info.filename)[1 if top else 0:]
        if not parts:
            continue
        path = os.path.join(dest, *parts)
        if info.is_dir():
            os.makedirs(path, exist_ok=True)
            continue
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with zf.open(info) as src, open(path, "wb") as out:
            shutil.copyfileobj(src, out, 1024 * 1024)


def _fix_permissions(root: str) -> None:
    as_root = os.geteuid() == 0
    for dirpath, _dirnames, filenames in os.walk(root):
        paths = [(dirpath, 0o755)] + [(os.path.join(dirpath, f), 0o644) for f in filenames]
        for path, mode in paths:
            os.chmod(path, mode)
            if as_root:
                os.chown(path, 0, 0)


def install_plugin_zip(src: str | os.PathLike[str] | bytes, plugins_dir: str, *, logger: logging.Logger) -> dict[str, Any]:
    try:
        archive = zipfile.ZipFile(io.BytesIO(src) if isinstance(src, bytes) else src)
    except zipfile.BadZipFile as e:
        raise ValueError(f"not a valid zip file: {e}") from None
    with archive as zf:
        top, meta, version = inspect_zip(zf)
        # Same naming rule as Decky's own zip installer.
        dirname = top or meta["name"].replace(" ", "-")
        if dirname in ("", ".", "..") or "/" in dirname or "\\" in dirname:
            raise ValueError(f"unusable plugin directory name {dirname!r}")
        os.makedirs(plugins_dir, exist_ok=True)
        # Stage next to (not inside) plugins_dir so the loader never sees a half-extracted plugin,
        # while staying on the same filesystem so the final rename is atomic.
        tmp = tempfile.mkdtemp(prefix=".decky-toolkit-install-", dir=os.path.dirname(os.path.abspath(plugins_dir)))
        target = os.path.join(plugins_dir, dirname)
        try:
            staged = os.path.join(tmp, "new")
            _extract(zf, top, staged)
            _fix_permissions(staged)
            old = os.path.join(tmp, "old")
            had_old = os.path.lexists(target)
            if had_old:
                os.rename(target, old)
            try:
                os.rename(staged, target)
            except OSError:
                if had_old:
                    os.rename(old, target)
                raise
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
    logger.info("installed plugin %s %s into %s", meta["name"], version or "", target)
    return {"dir": dirname, "name": meta["name"], "version": version}
