"""install.py validation and atomic replace. Run with: ./scripts/test.sh"""
import io
import json
import logging
import os
import stat
import sys
import zipfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "py_modules"))

from decky_mcp.install import install_plugin_zip  # noqa: E402

LOG = logging.getLogger("t")
META = {"name": "My Plugin", "author": "me", "flags": [], "api_version": 1}


def make_zip(files: dict[str, str | bytes], symlinks: dict[str, str] | None = None) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, data in files.items():
            zf.writestr(name, data)
        for name, target in (symlinks or {}).items():
            info = zipfile.ZipInfo(name)
            info.external_attr = (stat.S_IFLNK | 0o777) << 16
            zf.writestr(info, target)
    return buf.getvalue()


def plugin_files(prefix: str = "", meta: dict | None = None, version: str = "1.2.3") -> dict[str, str]:
    return {
        f"{prefix}plugin.json": json.dumps(meta or META),
        f"{prefix}package.json": json.dumps({"version": version}),
        f"{prefix}main.py": "print('hi')\n",
        f"{prefix}dist/index.js": "export default 1;\n",
    }


def test_nested_layout_uses_top_dir(tmp_path):
    plugins = tmp_path / "plugins"
    res = install_plugin_zip(make_zip(plugin_files("cool-plugin/")), str(plugins), logger=LOG)
    assert res == {"dir": "cool-plugin", "name": "My Plugin", "version": "1.2.3"}
    assert (plugins / "cool-plugin" / "dist" / "index.js").read_text() == "export default 1;\n"
    assert stat.S_IMODE(os.stat(plugins / "cool-plugin" / "main.py").st_mode) == 0o644
    assert stat.S_IMODE(os.stat(plugins / "cool-plugin" / "dist").st_mode) == 0o755
    # nothing left behind next to the plugins dir
    assert sorted(p.name for p in tmp_path.iterdir()) == ["plugins"]


def test_root_layout_uses_name_with_dashes(tmp_path):
    zpath = tmp_path / "p.zip"
    zpath.write_bytes(make_zip(plugin_files()))
    res = install_plugin_zip(str(zpath), str(tmp_path / "plugins"), logger=LOG)
    assert res["dir"] == "My-Plugin"
    assert (tmp_path / "plugins" / "My-Plugin" / "plugin.json").exists()


@pytest.mark.parametrize("files,symlinks,msg", [
    ({**plugin_files("p/"), "p/../../evil": "x"}, None, "traversal"),
    ({**plugin_files(), "../evil": "x"}, None, "traversal"),
    ({**plugin_files(), "/etc/evil": "x"}, None, "absolute"),
    (plugin_files(), {"link": "/etc/passwd"}, "symlink"),
    ({"p/main.py": "x"}, None, "plugin.json not found"),
    ({**plugin_files("a/"), **plugin_files("b/")}, None, "plugin.json not found"),
    (plugin_files(meta={**META, "api_version": "1"}), None, "api_version"),
    (plugin_files(meta={**META, "flags": "root"}), None, "flags"),
    (plugin_files(meta={k: v for k, v in META.items() if k != "author"}), None, "author"),
    (plugin_files(meta={**META, "name": "a/b"}), None, "directory name"),
])
def test_rejects_bad_zips(tmp_path, files, symlinks, msg):
    with pytest.raises(ValueError, match=msg):
        install_plugin_zip(make_zip(files, symlinks), str(tmp_path / "plugins"), logger=LOG)
    assert list(tmp_path.rglob("*")) in ([], [tmp_path / "plugins"])


def test_not_a_zip(tmp_path):
    with pytest.raises(ValueError, match="not a valid zip"):
        install_plugin_zip(b"nope", str(tmp_path / "plugins"), logger=LOG)


def test_replaces_existing_dir_atomically(tmp_path):
    plugins = tmp_path / "plugins"
    install_plugin_zip(make_zip({**plugin_files("p/", version="1.0.0"), "p/stale.txt": "old"}), str(plugins), logger=LOG)
    inode_before = os.stat(plugins / "p").st_ino
    res = install_plugin_zip(make_zip(plugin_files("p/", version="2.0.0")), str(plugins), logger=LOG)
    assert res["version"] == "2.0.0"
    assert not (plugins / "p" / "stale.txt").exists()
    assert json.loads((plugins / "p" / "package.json").read_text())["version"] == "2.0.0"
    assert os.stat(plugins / "p").st_ino != inode_before
    assert sorted(p.name for p in tmp_path.iterdir()) == ["plugins"]


def test_failed_validation_keeps_existing(tmp_path):
    plugins = tmp_path / "plugins"
    install_plugin_zip(make_zip(plugin_files("p/", version="1.0.0")), str(plugins), logger=LOG)
    with pytest.raises(ValueError):
        install_plugin_zip(make_zip({**plugin_files("p/"), "p/../x": "y"}), str(plugins), logger=LOG)
    assert json.loads((plugins / "p" / "package.json").read_text())["version"] == "1.0.0"
