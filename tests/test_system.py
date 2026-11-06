"""Shared helpers: desktop user, environment, tail, plugin dir names. Run with: ./scripts/test.sh"""
import os
import pwd
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "py_modules"))

from decky_toolkit import system  # noqa: E402
from decky_toolkit.loader import logs  # noqa: E402
from decky_toolkit.loader.plugins import check_dir_name, plugin_name  # noqa: E402

ME = pwd.getpwuid(os.getuid())


def test_desktop_user_follows_decky_user(monkeypatch):
    monkeypatch.setenv("DECKY_USER", ME.pw_name)
    monkeypatch.delenv("DECKY_USER_HOME", raising=False)
    assert system.desktop_user().pw_uid == ME.pw_uid
    assert system.user_home() == ME.pw_dir
    assert system.user_runtime_dir() == f"/run/user/{ME.pw_uid}"
    monkeypatch.setenv("DECKY_USER_HOME", "/home/elsewhere")
    assert system.user_home() == "/home/elsewhere"


@pytest.mark.parametrize("name", [None, "no-such-user-here"])
def test_desktop_user_outside_the_loader_is_the_current_user(monkeypatch, name):
    if name is None:
        monkeypatch.delenv("DECKY_USER", raising=False)
    else:
        monkeypatch.setenv("DECKY_USER", name)
    assert system.desktop_user().pw_uid == ME.pw_uid


def test_clean_env_drops_the_loader_libs(monkeypatch):
    monkeypatch.setenv("LD_LIBRARY_PATH", "/tmp/_MEI123")
    env = system.clean_env()
    assert "LD_LIBRARY_PATH" not in env and env["PATH"] == os.environ["PATH"]


def test_tail_reads_across_blocks(tmp_path):
    f = tmp_path / "log"
    f.write_text("".join(f"line {i:06d} {'x' * 100}\n" for i in range(3000)))
    out = system.tail(str(f), 1000).splitlines()
    assert len(out) == 1000 and out[0].startswith("line 002000") and out[-1].startswith("line 002999")
    assert system.tail(str(f), 5000).splitlines()[0].startswith("line 000000")
    (tmp_path / "short").write_text("a\nb")
    assert system.tail(str(tmp_path / "short"), 1) == "b"
    (tmp_path / "empty").write_text("")
    assert system.tail(str(tmp_path / "empty"), 3) == ""


@pytest.mark.parametrize("bad", ["", ".", "..", ".hidden", "a/b", "../x", None])
def test_plugin_dir_names_are_checked_everywhere(bad, monkeypatch, tmp_path):
    monkeypatch.setenv("DECKY_HOME", str(tmp_path))
    for fn in (check_dir_name, plugin_name, logs.plugin_log_dir):
        with pytest.raises(ValueError, match="bare plugin directory name"):
            fn(bad)


def test_plugin_dir_name_ok(monkeypatch, tmp_path):
    monkeypatch.setenv("DECKY_HOME", str(tmp_path))
    assert check_dir_name("decky-mcp") == "decky-mcp"
    assert logs.plugin_log_dir("decky-mcp") == f"{tmp_path}/logs/decky-mcp"
