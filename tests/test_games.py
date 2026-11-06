"""Game dirs, save ranking, VDF parsing and the guarded file tools against a fake Steam tree. Run with: ./scripts/test.sh"""
import asyncio
import os
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "py_modules"))

from decky_toolkit.games import files as games, vdf  # noqa: E402
from decky_toolkit.games.files import SensitivePath  # noqa: E402

from test_routes import H, with_server  # noqa: E402

ACCOUNT = "95599472"
PROTON_APP, NATIVE_APP = 2567870, 70300

REMOTECACHE = """"2567870"
{
	"ChangeNumber"		"38"
	"OSType"		"0"
	"ChainedTogether/Saved/SaveGames/Progress.sav"
	{
		"root"		"3"
		"size"		"30519"
		"localtime"		"1793781381"
		"time"		"1793781381"
		"syncstate"		"1"
	}
	"ChainedTogether/Saved/SaveGames/Missing.sav"
	{
		"root"		"3"
		"size"		"10"
		"time"		"1793781381"
	}
}
"""


def write(p: Path, text: str = "x", mtime: float | None = None) -> Path:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text)
    if mtime:
        os.utime(p, (mtime, mtime))
    return p


@pytest.fixture
def tree(tmp_path):
    """A home with a Steam root, a second library, a Proton title and a native title."""
    home = tmp_path / "home"
    root = home / ".local/share/Steam"
    lib2 = tmp_path / "sdcard"
    write(root / "steamapps/libraryfolders.vdf", f'''"libraryfolders"
{{
	"0" {{ "path" "{root}" "apps" {{ "70300" "75883262" }} }}
	"1" {{ "path" "{lib2}" "apps" {{ "2567870" "8493964009" }} }}
}}
''')
    write(lib2 / f"steamapps/appmanifest_{PROTON_APP}.acf", '''"AppState"
{
	"appid"		"2567870"
	"name"		"Chained Together"
	"installdir"		"ChainedTogether"
	"SizeOnDisk"		"8493964009"
	"LastUpdated"		"1790000000"
	"StateFlags"		"4"
}
''')
    write(lib2 / "steamapps/common/ChainedTogether/ChainedTogether.exe")
    write(lib2 / "steamapps/common/ChainedTogether/Engine/Content/Slate.pak")
    pfx_user = lib2 / f"steamapps/compatdata/{PROTON_APP}/pfx/drive_c/users/steamuser"
    write(pfx_user / "AppData/Local/ChainedTogether/Saved/SaveGames/Progress.sav", "save", mtime=time.time() - 60)
    write(pfx_user / "AppData/Local/ChainedTogether/Saved/Config/Windows/GameUserSettings.ini")
    write(pfx_user / "AppData/Local/ChainedTogether/Saved/Logs/ChainedTogether.log")
    write(pfx_user / "AppData/Local/Microsoft/whatever.dat")
    for d in ("AppData/Roaming", "AppData/LocalLow", "Documents", "Saved Games"):
        (pfx_user / d).mkdir(parents=True, exist_ok=True)
    (lib2 / f"steamapps/shadercache/{PROTON_APP}").mkdir(parents=True)
    write(root / f"userdata/{ACCOUNT}/{PROTON_APP}/remotecache.vdf", REMOTECACHE)
    write(root / f"userdata/{ACCOUNT}/config/localconfig.vdf")

    write(root / f"steamapps/appmanifest_{NATIVE_APP}.acf",
          '"AppState" { "appid" "70300" "name" "VVVVVV" "installdir" "vvvvvv" }')
    write(root / "steamapps/common/vvvvvv/VVVVVV")
    write(home / ".local/share/VVVVVV/saves/tsave.vvv", "s")
    write(home / ".local/share/VVVVVV/saves/steam_autocloud.vdf", "")
    write(home / ".local/share/VVVVVV/saves/settings.vvv", "s")
    write(home / ".local/share/Unrelated/save.dat")
    write(root / f"userdata/{ACCOUNT}/{NATIVE_APP}/remotecache.vdf",
          '"70300" { "VVVVVV/saves/tsave.vvv" { "root" "2" "size" "1" "time" "1" } }')
    write(root / "config/loginusers.vdf", "secret")
    write(root / "config/config.vdf", "secret")
    write(root / "ssfn123456", "secret")
    return {"home": str(home), "root": str(root), "lib2": str(lib2), "pfx_user": pfx_user}


def test_vdf_parsing():
    data = vdf.loads('''// comment
"Root"
{
	"key"		"value"
	"esc"		"a\\"b\\\\c"
	"nested" { "deep" "1" }
	"cond"		"x"	[$WIN32]
	bare		token
}''')
    assert data["Root"]["key"] == "value"
    assert data["Root"]["esc"] == 'a"b\\c'
    assert data["Root"]["nested"] == {"deep": "1"}
    assert data["Root"]["cond"] == "x"
    assert data["Root"]["bare"] == "token"


def test_parse_remotecache(tmp_path):
    p = write(tmp_path / "remotecache.vdf", REMOTECACHE)
    items = games.parse_remotecache(str(p))
    assert [i["name"] for i in items] == ["ChainedTogether/Saved/SaveGames/Progress.sav",
                                          "ChainedTogether/Saved/SaveGames/Missing.sav"]
    assert items[0]["root"] == 3 and items[0]["size"] == 30519 and items[0]["time"] == 1793781381


def test_library_folders_and_manifest(tree):
    libs = games.library_folders(tree["root"])
    assert libs == [tree["root"], tree["lib2"]]
    m = games.find_manifest(PROTON_APP, libs)
    assert m["library"] == tree["lib2"] and m["install_dir"].endswith("steamapps/common/ChainedTogether")
    assert m["size_on_disk"] == 8493964009 and m["last_updated"].startswith("2026-")
    assert games.find_manifest(1, libs) is None


def test_game_dirs_proton(tree):
    d = games.game_dirs(PROTON_APP, name="Chained Together", developer="Anegar Games", compat_tool="proton_11",
                        account_id=ACCOUNT, home=tree["home"], root=tree["root"])
    assert d["platform"] == "proton" and d["library"] == tree["lib2"]
    assert d["install_dir"]["exists"] and d["prefix"]["exists"]
    assert d["prefix"]["path"] == f"{tree['lib2']}/steamapps/compatdata/{PROTON_APP}/pfx"
    local = d["prefix_user_dirs"]["appdata_local"]
    assert local["exists"] and local["matches"] == [str(tree["pfx_user"] / "AppData/Local/ChainedTogether")]
    assert d["prefix_user_dirs"]["saved_games"]["exists"] and d["prefix_user_dirs"]["documents"]["matches"] == []
    assert d["userdata"]["path"].endswith(f"userdata/{ACCOUNT}/{PROTON_APP}") and d["remotecache"]["exists"]
    assert not d["cloud_remote"]["exists"]
    assert d["shader_cache"]["exists"] and d["shader_cache"]["path"].startswith(tree["lib2"])
    assert d["xdg"] == []


def test_game_dirs_native_xdg_and_account_guess(tree):
    d = games.game_dirs(NATIVE_APP, name="VVVVVV", developer="Terry Cavanagh", compat_tool="steamlinuxruntime_sniper",
                        home=tree["home"], root=tree["root"])
    assert d["platform"] == "native" and d["account_id"] == ACCOUNT
    assert [x["path"] for x in d["xdg"]] == [f"{tree['home']}/.local/share/VVVVVV"]
    assert not d["prefix"]["exists"]


def test_game_saves_ranking(tree):
    d = games.game_dirs(PROTON_APP, name="Chained Together", developer="Anegar Games", compat_tool="proton_11",
                        account_id=ACCOUNT, home=tree["home"], root=tree["root"])
    s = games.game_saves(PROTON_APP, d, home=tree["home"])
    first = s["candidates"][0]
    assert first["path"].endswith("SaveGames/Progress.sav") and first["found_by"].startswith("steam_cloud")
    assert first["cloud_size"] == 30519 and first["size"] == 4
    missing = next(c for c in s["steam_cloud"] if c["name"].endswith("Missing.sav"))
    assert missing["local_path"] is None and missing["candidates"][0].endswith("AppData/Local/ChainedTogether/Saved/SaveGames/Missing.sav")
    paths = [c["path"] for c in s["candidates"]]
    assert not any(p.endswith((".log", ".pak", ".exe")) for p in paths)
    assert not any("Microsoft" in p for p in paths), "only dirs named after the game are scanned"
    ini = next(c for c in s["candidates"] if c["path"].endswith("GameUserSettings.ini"))
    assert ini["found_by"].startswith("heuristic") and ini["rank"] > first["rank"]


def test_game_saves_native_autocloud(tree):
    d = games.game_dirs(NATIVE_APP, name="VVVVVV", compat_tool="steamlinuxruntime_sniper", home=tree["home"],
                        root=tree["root"])
    s = games.game_saves(NATIVE_APP, d, home=tree["home"])
    by_name = {os.path.basename(c["path"]): c for c in s["candidates"]}
    assert by_name["tsave.vvv"]["found_by"] == "steam_cloud remotecache (root 2)" and by_name["tsave.vvv"]["rank"] == 0
    assert by_name["settings.vvv"]["found_by"].startswith("steam_autocloud")
    assert "steam_autocloud.vdf" not in by_name and "save.dat" not in by_name


def test_sensitive_paths(tree):
    root = Path(tree["root"])
    assert games.is_sensitive(str(root / "config/loginusers.vdf"))
    assert games.is_sensitive(str(root / "config/config.vdf"))
    assert games.is_sensitive(str(root / "ssfn123456"))
    assert not games.is_sensitive(str(root / "config/libraryfolders.vdf"))
    assert not games.is_sensitive(str(root / "steamapps/common/x/config.vdf"))
    link = root / "steamapps/common/vvvvvv/innocent"
    link.symlink_to(root / "config/loginusers.vdf")
    assert games.is_sensitive(str(link)), "resolved through symlinks"
    for fn in (games.fs_stat, games.fs_list):
        with pytest.raises(SensitivePath):
            fn(str(root / "config/loginusers.vdf"), home=tree["home"])
    listing = games.fs_list("~/.local/share/Steam/config", home=tree["home"])
    flagged = {e["path"] for e in listing["entries"] if e.get("sensitive")}
    assert flagged == {"loginusers.vdf", "config.vdf"}


def test_fs_list_and_stat(tree):
    with pytest.raises(ValueError):
        games.fs_list("relative/path")
    with pytest.raises(ValueError):
        games.fs_list("/", depth=9)
    with pytest.raises(FileNotFoundError):
        games.fs_list(f"{tree['home']}/nope")
    out = games.fs_list("~/.local/share/VVVVVV", depth=2, home=tree["home"])
    assert {e["path"] for e in out["entries"]} == {"saves", "saves/tsave.vvv", "saves/steam_autocloud.vdf", "saves/settings.vvv"}
    out = games.fs_list("~/.local/share/VVVVVV", depth=2, glob="*.vvv", home=tree["home"])
    assert {e["path"] for e in out["entries"]} == {"saves/tsave.vvv", "saves/settings.vvv"}
    out = games.fs_list("~/.local/share/VVVVVV", depth=2, home=tree["home"], max_entries=2)
    assert out["truncated"] and out["count"] == 2
    st = games.fs_stat("~/.local/share/VVVVVV/saves/tsave.vvv", home=tree["home"])
    assert st["type"] == "file" and st["size"] == 1


def test_fs_delete_guards(tree):
    root, lib2, home = tree["root"], tree["lib2"], tree["home"]
    runtime = Path(home) / "runtime"
    write(runtime / "recordings/a.mkv")
    roots = games.delete_roots(root, games.library_folders(root), str(runtime))
    save = f"{lib2}/steamapps/compatdata/{PROTON_APP}/pfx/drive_c/users/steamuser/AppData/Local/ChainedTogether/Saved/SaveGames/Progress.sav"
    with pytest.raises(ValueError, match="confirm"):
        games.fs_delete(save, False, roots)
    with pytest.raises(ValueError, match="confirm"):
        games.fs_delete(save, "true", roots)  # type: ignore[arg-type]
    refused = [
        f"{lib2}/steamapps/common/ChainedTogether",  # a whole game dir
        f"{lib2}/steamapps/common",
        f"{root}/userdata/{ACCOUNT}",
        f"{root}/userdata/{ACCOUNT}/config/localconfig.vdf",
        f"{home}/.local/share/VVVVVV/saves/tsave.vvv",
        f"{lib2}/steamapps/appmanifest_{PROTON_APP}.acf",
        f"{lib2}/steamapps/common/ChainedTogether/../../appmanifest_{PROTON_APP}.acf",
    ]
    for p in refused:
        with pytest.raises(ValueError, match="refused"):
            games.fs_delete(p, True, roots)
    with pytest.raises(SensitivePath):
        games.fs_delete(f"{root}/config/loginusers.vdf", True, roots)
    # A symlink inside a game dir pointing outside removes the link, not the target.
    outside = write(Path(home) / "precious.txt", "keep")
    link = Path(lib2) / "steamapps/common/ChainedTogether/link"
    link.symlink_to(outside)
    assert games.fs_delete(str(link), True, roots)["files"] == 1
    assert outside.read_text() == "keep" and not link.exists()
    escape = Path(lib2) / "steamapps/common/ChainedTogether/escape"
    escape.symlink_to(Path(home) / ".local/share/VVVVVV", target_is_directory=True)
    with pytest.raises(ValueError, match="refused"):
        games.fs_delete(str(escape / "saves/tsave.vvv"), True, roots)

    assert games.fs_delete(save, True, roots) == {"deleted": save, "files": 1, "bytes": 4}
    res = games.fs_delete(f"{lib2}/steamapps/compatdata/{PROTON_APP}", True, roots)
    assert res["files"] >= 3 and not Path(f"{lib2}/steamapps/compatdata/{PROTON_APP}").exists()
    assert games.fs_delete(f"{root}/userdata/{ACCOUNT}/{NATIVE_APP}", True, roots)["files"] == 1
    assert games.fs_delete(str(runtime / "recordings/a.mkv"), True, roots)["files"] == 1
    with pytest.raises(FileNotFoundError):
        games.fs_delete(save, True, roots)


def test_proton_log(tree):
    home, root = tree["home"], tree["root"]
    write(Path(root) / "logs/compat_log.txt", "a 2567870 start\nb 12567870 other\nc AppID 2567870 stop\n")
    out = games.proton_log(PROTON_APP, 10, home=home, root=root)
    assert out["proton_log"]["exists"] is False and "PROTON_LOG" in out["proton_log"]["hint"]
    assert out["steam_logs"][0]["lines"] == ["a 2567870 start", "c AppID 2567870 stop"]
    write(Path(home) / f"steam-{PROTON_APP}.log", "\n".join(f"line {i}" for i in range(50)))
    out = games.proton_log(PROTON_APP, 3, home=home, root=root)
    assert out["proton_log"]["lines"] == ["line 47", "line 48", "line 49"]


def test_fs_route(tree, monkeypatch):
    monkeypatch.setenv("DECKY_USER_HOME", tree["home"])

    async def run(s, base):
        async with s.get(f"{base}/api/v1/fs?path=~/.local/share/VVVVVV&depth=2") as r:
            assert r.status == 401
        async with s.get(f"{base}/api/v1/fs?path=~/.local/share/VVVVVV&depth=2", headers=H) as r:
            assert r.status == 200
            assert (await r.json())["count"] == 4
        async with s.get(f"{base}/api/v1/fs?path=~/.local/share/Steam/config/loginusers.vdf", headers=H) as r:
            assert r.status == 403
        async with s.get(f"{base}/api/v1/fs?path=~/nope", headers=H) as r:
            assert r.status == 404
        async with s.get(f"{base}/api/v1/fs?path=relative", headers=H) as r:
            assert r.status == 400
        async with s.get(f"{base}/api/v1/fs", headers=H) as r:
            assert r.status == 400
        async with s.get(f"{base}/api/v1/fs?path=/&depth=x", headers=H) as r:
            assert r.status == 400
    asyncio.run(with_server(run))


def fs_env(tree, tmp_path):
    root = tree["root"]
    runtime = tmp_path / "runtime"
    runtime.mkdir(exist_ok=True)
    libs = games.library_folders(root)
    return games.write_roots(root, libs, str(runtime)), games.installed_name_keys(libs), runtime


def test_fs_read_write_mkdir_rename(tree, tmp_path):
    home, root, lib2 = tree["home"], tree["root"], tree["lib2"]
    roots, keys, runtime = fs_env(tree, tmp_path)
    assert "vvvvvv" in keys and "chainedtogether" in keys

    assert games.fs_read("~/.local/share/VVVVVV/saves/tsave.vvv", home=home) == b"s"
    with pytest.raises(SensitivePath):
        games.fs_read(f"{root}/config/loginusers.vdf", home=home)
    with pytest.raises(IsADirectoryError):
        games.fs_read("~/.local/share/VVVVVV", home=home)
    with pytest.raises(FileNotFoundError):
        games.fs_read("~/nope", home=home)
    with pytest.raises(games.TooLarge):
        games.fs_read("~/.local/share/VVVVVV/saves/tsave.vvv", home=home, max_bytes=0)

    new = str(runtime / "a/b/new.txt")
    assert games.fs_write(new, b"hi", roots, keys, home=home) == {"path": new, "bytes": 2, "created": True}
    assert Path(new).read_bytes() == b"hi" and oct(Path(new).stat().st_mode & 0o777) == "0o644"
    with pytest.raises(FileExistsError):
        games.fs_write(new, b"x", roots, keys, home=home, overwrite=False)
    with pytest.raises(FileNotFoundError):
        games.fs_write(str(runtime / "missing.txt"), b"x", roots, keys, home=home, create=False)
    os.chmod(new, 0o600)
    assert games.fs_write(new, b"again", roots, keys, home=home)["created"] is False
    assert Path(new).read_bytes() == b"again" and oct(Path(new).stat().st_mode & 0o777) == "0o600"
    assert not [p for p in os.listdir(runtime / "a/b") if p.endswith(".tmp")]

    save = f"{home}/.local/share/VVVVVV/saves/tsave.vvv"
    pfx_file = f"{tree['pfx_user']}/AppData/Local/ChainedTogether/Saved/SaveGames/New.sav"
    for ok in (save, pfx_file, f"{root}/userdata/{ACCOUNT}/{NATIVE_APP}/remote/x", f"{root}/steamapps/common/vvvvvv/x.cfg"):
        assert games.writable(ok, roots, home, keys), ok
    for bad in (f"{home}/.bashrc", f"{home}/.local/share/Unrelated/save.dat", f"{home}/.local/share/VVVVVV",
                f"{root}/steamapps/common/x", f"{lib2}/steamapps/compatdata/{PROTON_APP}", f"{root}/userdata/{ACCOUNT}/config/x",
                f"{root}/config/x.vdf", f"{home}/.config/x", "/etc/passwd", str(runtime)):
        assert not games.writable(bad, roots, home, keys), bad
        with pytest.raises(PermissionError):
            games.fs_write(bad, b"x", roots, keys, home=home)
    with pytest.raises(SensitivePath):
        games.fs_write(f"{root}/config/loginusers.vdf", b"x", roots, keys, home=home)
    with pytest.raises(PermissionError):
        games.fs_write(f"{root}/steamapps/common/vvvvvv/steamapps/libraryfolders.vdf", b"x", roots, keys, home=home)

    escape = tmp_path / "outside"
    escape.mkdir()
    link = runtime / "link"
    link.symlink_to(escape)
    with pytest.raises(PermissionError):
        games.fs_write(str(link / "f"), b"x", roots, keys, home=home)
    assert not (escape / "f").exists()

    d = str(runtime / "dir")
    assert games.fs_mkdir(d, roots, keys, home=home)["created"]
    with pytest.raises(FileExistsError):
        games.fs_mkdir(d, roots, keys, home=home)
    with pytest.raises(FileNotFoundError):
        games.fs_mkdir(str(runtime / "x/y"), roots, keys, home=home)
    assert games.fs_mkdir(str(runtime / "x/y"), roots, keys, home=home, parents=True)["created"]

    dst = str(runtime / "dir/moved.txt")
    assert games.fs_rename(new, dst, roots, keys, home=home) == {"from": new, "to": dst}
    assert Path(dst).read_bytes() == b"again" and not Path(new).exists()
    games.fs_write(new, b"1", roots, keys, home=home)
    with pytest.raises(FileExistsError):
        games.fs_rename(new, dst, roots, keys, home=home)
    games.fs_rename(new, dst, roots, keys, home=home, overwrite=True)
    with pytest.raises(PermissionError):
        games.fs_rename(dst, f"{home}/moved.txt", roots, keys, home=home)
    with pytest.raises(PermissionError):
        games.fs_rename(f"{home}/.local/share/Unrelated/save.dat", str(runtime / "s.dat"), roots, keys, home=home)


def test_fs_write_routes(tree, tmp_path, monkeypatch):
    home, root = tree["home"], tree["root"]
    runtime = tmp_path / "runtime"
    runtime.mkdir()
    monkeypatch.setenv("DECKY_USER_HOME", home)
    monkeypatch.setenv("DECKY_PLUGIN_RUNTIME_DIR", str(runtime))
    cookie = {"Cookie": "decky_toolkit_token=test-token"}
    q = "path=" + str(runtime / "sub/f.bin")

    async def run(s, base):
        async with s.get(f"{base}/api/v1/fs/read?path=~/.local/share/VVVVVV/saves/tsave.vvv", headers=H) as r:
            assert r.status == 200 and r.content_type == "application/octet-stream" and await r.read() == b"s"
        for method, url in (("GET", "/fs/read?path=~/.local/share/VVVVVV/saves/tsave.vvv"), ("PUT", f"/fs/write?{q}"),
                            ("POST", "/fs/mkdir"), ("POST", "/fs/rename"), ("DELETE", f"/fs?{q}&confirm=1")):
            async with s.request(method, base + url, headers=cookie) as r:
                assert r.status == 401, url
        async with s.get(f"{base}/api/v1/fs/read?path=~/.local/share/Steam/config/loginusers.vdf", headers=H) as r:
            assert r.status == 403
        async with s.get(f"{base}/api/v1/fs/read?path=~/nope", headers=H) as r:
            assert r.status == 404 and (await r.json())["code"] == "ENOENT"
        async with s.get(f"{base}/api/v1/fs/read?path=~/.local/share/VVVVVV", headers=H) as r:
            assert r.status == 409 and (await r.json())["code"] == "EISDIR"
        async with s.put(f"{base}/api/v1/fs/write?{q}", data=b"\x00\x01binary", headers=H) as r:
            assert r.status == 200 and (await r.json())["created"] is True
        assert (runtime / "sub/f.bin").read_bytes() == b"\x00\x01binary"
        async with s.put(f"{base}/api/v1/fs/write?{q}&overwrite=0", data=b"x", headers=H) as r:
            assert r.status == 409 and (await r.json())["code"] == "EEXIST"
        async with s.put(f"{base}/api/v1/fs/write?path={home}/.bashrc", data=b"x", headers=H) as r:
            assert r.status == 403
        async with s.put(f"{base}/api/v1/fs/write?path={root}/config/loginusers.vdf", data=b"x", headers=H) as r:
            assert r.status == 403
        async with s.post(f"{base}/api/v1/fs/mkdir", json={"path": str(runtime / "d")}, headers=H) as r:
            assert r.status == 200
        async with s.post(f"{base}/api/v1/fs/mkdir", json={"path": str(runtime / "d")}, headers=H) as r:
            assert r.status == 409
        async with s.post(f"{base}/api/v1/fs/rename", json={"from": str(runtime / "sub/f.bin"), "to": str(runtime / "d/g.bin")}, headers=H) as r:
            assert r.status == 200
        async with s.post(f"{base}/api/v1/fs/rename", json={"from": str(runtime / "d/g.bin")}, headers=H) as r:
            assert r.status == 400
        async with s.delete(f"{base}/api/v1/fs?path={runtime}/d/g.bin", headers=H) as r:
            assert r.status == 400 and "confirm=1" in (await r.json())["error"]
        async with s.delete(f"{base}/api/v1/fs?path={runtime}/d/g.bin&confirm=1", headers=H) as r:
            assert r.status == 200 and (await r.json())["files"] == 1
        async with s.delete(f"{base}/api/v1/fs?path=~/.local/share/VVVVVV/saves/tsave.vvv&confirm=1", headers=H) as r:
            assert r.status == 403
        async with s.delete(f"{base}/api/v1/fs?path=~/.local/share/Steam/config/loginusers.vdf&confirm=1", headers=H) as r:
            assert r.status == 403
        async with s.delete(f"{base}/api/v1/fs?path={runtime}/nope&confirm=1", headers=H) as r:
            assert r.status == 404
    asyncio.run(with_server(run))
    assert (Path(home) / ".local/share/VVVVVV/saves/tsave.vvv").exists()
