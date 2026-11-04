"""Tool registry and the built-in Decky development tools."""
import asyncio
import base64
import json
import os
import platform
import sys
import traceback
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

from . import cdp
from .capture import CaptureUnavailable, ScreenCapturer

ToolFn = Callable[..., Awaitable[Any]]


@dataclass
class Tool:
    name: str
    description: str
    input_schema: dict[str, Any]
    fn: ToolFn


class ToolRegistry:
    def __init__(self) -> None:
        self._tools: dict[str, Tool] = {}

    def __len__(self) -> int:
        return len(self._tools)

    def add(self, name: str, description: str, input_schema: dict[str, Any] | None = None) -> Callable[[ToolFn], ToolFn]:
        def deco(fn: ToolFn) -> ToolFn:
            schema = input_schema or {"type": "object", "properties": {}}
            schema.setdefault("type", "object")
            schema.setdefault("properties", {})
            self._tools[name] = Tool(name, description, schema, fn)
            return fn
        return deco

    def describe(self) -> list[dict[str, Any]]:
        return [{"name": t.name, "description": t.description, "inputSchema": t.input_schema} for t in self._tools.values()]

    async def call(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        tool = self._tools.get(name)
        if tool is None:
            raise ValueError(f"Unknown tool: {name}")
        try:
            result = await tool.fn(**arguments)
        except TypeError as e:
            # Bad/missing arguments surface as a tool error so the agent can self-correct.
            return _error_result(f"Invalid arguments for {name}: {e}")
        except (ValueError, FileNotFoundError, cdp.CdpError, CaptureUnavailable) as e:
            # Expected, user-facing failures: no traceback noise.
            return _error_result(f"{type(e).__name__}: {e}")
        except Exception as e:  # noqa: BLE001
            return _error_result(f"{type(e).__name__}: {e}\n{traceback.format_exc()}")
        return _ok_result(result)


_CONTENT_TYPES = {"text", "image", "audio", "resource", "resource_link"}


def _ok_result(result: Any) -> dict[str, Any]:
    if isinstance(result, list) and result and all(isinstance(c, dict) and c.get("type") in _CONTENT_TYPES for c in result):
        return {"content": result, "isError": False}
    if isinstance(result, str):
        text = result
    else:
        text = json.dumps(result, indent=2, ensure_ascii=False, default=str)
    return {"content": [{"type": "text", "text": text}], "isError": False}


def _error_result(text: str) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": text}], "isError": True}


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default)


def _plugins_dir() -> str:
    return os.path.join(_env("DECKY_HOME"), "plugins")


async def _run(*argv: str, timeout: float = 20) -> tuple[int, str]:
    # The PyInstaller-launched loader exports LD_LIBRARY_PATH pointing at its own libs, which breaks
    # system binaries (notably /usr/bin/python3) on Bazzite. Strip it like the loader's own run() does.
    env = {k: v for k, v in os.environ.items() if k != "LD_LIBRARY_PATH"}
    proc = await asyncio.create_subprocess_exec(*argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT, env=env)
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout)
    except asyncio.TimeoutError:
        proc.kill()
        raise
    return proc.returncode or 0, out.decode(errors="replace")


def _tail(path: str, lines: int) -> str:
    with open(path, "rb") as f:
        f.seek(0, os.SEEK_END)
        size = f.tell()
        block = 64 * 1024
        data = b""
        while size > 0 and data.count(b"\n") <= lines:
            step = min(block, size)
            size -= step
            f.seek(size)
            data = f.read(step) + data
    return b"\n".join(data.splitlines()[-lines:]).decode(errors="replace")


def build_registry(capturer: ScreenCapturer | None = None) -> ToolRegistry:
    reg = ToolRegistry()

    @reg.add("decky_status", "Report Decky Loader version, host OS, Python runtime and installed plugins.")
    async def decky_status() -> dict[str, Any]:
        os_release: dict[str, str] = {}
        try:
            with open("/etc/os-release") as f:
                for line in f:
                    k, _, v = line.strip().partition("=")
                    if k:
                        os_release[k] = v.strip('"')
        except OSError:
            pass
        return {
            "decky_version": _env("DECKY_VERSION"),
            "decky_home": _env("DECKY_HOME"),
            "decky_user": _env("DECKY_USER"),
            "running_as_uid": os.getuid(),
            "python": sys.version,
            "kernel": platform.release(),
            "os": {k: os_release.get(k) for k in ("PRETTY_NAME", "IMAGE_ID", "VERSION_ID")},
            "plugins": await list_plugins(),
        }

    @reg.add("list_plugins", "List plugins installed under ~/homebrew/plugins with their plugin.json metadata.")
    async def list_plugins() -> list[dict[str, Any]]:
        out = []
        root = _plugins_dir()
        for entry in sorted(os.listdir(root)) if os.path.isdir(root) else []:
            path = os.path.join(root, entry)
            if not os.path.isdir(path):
                continue
            info: dict[str, Any] = {"dir": entry, "path": path}
            try:
                with open(os.path.join(path, "plugin.json")) as f:
                    meta = json.load(f)
                info.update({k: meta.get(k) for k in ("name", "author", "flags", "api_version")})
                with open(os.path.join(path, "package.json")) as f:
                    info["version"] = json.load(f).get("version")
            except (OSError, json.JSONDecodeError) as e:
                info["error"] = str(e)
            info["has_backend"] = os.path.exists(os.path.join(path, "main.py"))
            out.append(info)
        return out

    @reg.add(
        "read_plugin_log",
        "Tail a plugin's backend log from ~/homebrew/logs/<plugin_dir>/. Omit 'file' to pick the newest log.",
        {
            "properties": {
                "plugin_dir": {"type": "string", "description": "Plugin directory name, as returned by list_plugins"},
                "lines": {"type": "integer", "default": 200, "minimum": 1, "maximum": 5000},
                "file": {"type": "string", "description": "Specific log file name inside the plugin's log dir"},
            },
            "required": ["plugin_dir"],
        },
    )
    async def read_plugin_log(plugin_dir: str, lines: int = 200, file: str | None = None) -> dict[str, Any]:
        if "/" in plugin_dir or plugin_dir.startswith("."):
            raise ValueError("plugin_dir must be a bare directory name")
        log_dir = os.path.join(_env("DECKY_HOME"), "logs", plugin_dir)
        if not os.path.isdir(log_dir):
            raise FileNotFoundError(f"No log dir {log_dir}")
        files = sorted(os.listdir(log_dir), key=lambda n: os.path.getmtime(os.path.join(log_dir, n)), reverse=True)
        if not files:
            return {"log_dir": log_dir, "files": [], "text": ""}
        chosen = file or files[0]
        if chosen not in files:
            raise FileNotFoundError(f"{chosen} not in {files}")
        return {"log_dir": log_dir, "files": files, "file": chosen, "text": _tail(os.path.join(log_dir, chosen), lines)}

    @reg.add(
        "loader_log",
        "Tail the Decky Loader systemd journal (plugin_loader.service). Includes every plugin's stdout/stderr.",
        {"properties": {"lines": {"type": "integer", "default": 200, "minimum": 1, "maximum": 5000},
                        "grep": {"type": "string", "description": "Optional case-insensitive substring filter"}}},
    )
    async def loader_log(lines: int = 200, grep: str | None = None) -> str:
        argv = ["journalctl", "-u", "plugin_loader", "--no-pager", "-o", "short-iso", "-n", str(lines if not grep else max(lines * 10, 2000))]
        code, out = await _run(*argv)
        if code != 0:
            raise RuntimeError(out)
        if grep:
            needle = grep.lower()
            out = "\n".join(l for l in out.splitlines() if needle in l.lower())
            out = "\n".join(out.splitlines()[-lines:])
        return out

    @reg.add(
        "restart_loader",
        "Restart plugin_loader.service (reloads every plugin, including this server). "
        "The restart is scheduled 1s out so this call can return first; reconnect afterwards.",
    )
    async def restart_loader() -> str:
        code, out = await _run("systemd-run", "--on-active=1", "--timer-property=AccuracySec=100ms",
                               "systemctl", "restart", "plugin_loader")
        if code != 0:
            raise RuntimeError(out)
        return "plugin_loader restart scheduled in ~1s. The MCP server will drop and come back on the same port."

    @reg.add("cef_targets", "List Steam CEF DevTools targets (tabs) exposed on localhost:8080.")
    async def cef_targets() -> list[dict[str, Any]]:
        return [{k: t.get(k) for k in ("id", "type", "title", "url")} for t in await cdp.list_targets()]

    @reg.add(
        "cef_evaluate",
        "Evaluate a JavaScript expression in a Steam CEF tab via DevTools Runtime.evaluate and return its JSON value. "
        "Defaults to SharedJSContext, where Decky's frontend (window.DeckyPluginLoader) lives. "
        "Promises are awaited. Wrap statements in an IIFE or async IIFE to return a value.",
        {
            "properties": {
                "expression": {"type": "string"},
                "target": {"type": "string", "description": "Tab title to target, e.g. 'SharedJSContext' or 'QuickAccess_uid2'"},
                "timeout": {"type": "number", "default": 15},
            },
            "required": ["expression"],
        },
    )
    async def cef_evaluate(expression: str, target: str | None = None, timeout: float = 15) -> Any:
        value = await cdp.evaluate_in(target, expression, timeout=timeout)
        return value if value is not None else "undefined"

    @reg.add(
        "cef_screenshot",
        "Capture a PNG screenshot of a Steam CEF tab (default: the main Big Picture window).",
        {"properties": {"target": {"type": "string"}, "quality_scale": {"type": "number", "default": 0.5, "minimum": 0.1, "maximum": 1}}},
    )
    async def cef_screenshot(target: str | None = None, quality_scale: float = 0.5) -> list[dict[str, Any]]:
        tab_title = target
        if tab_title is None:
            titles = [t.get("title", "") for t in await cdp.list_targets()]
            tab_title = next((t for t in titles if t.startswith("Steam Big Picture Mode")), None) or "SharedJSContext"
        t = await cdp.find_target(tab_title)
        async with cdp.Tab(t) as tab:
            metrics = await tab.send("Page.getLayoutMetrics")
            css = metrics.get("cssVisualViewport", {})
            res = await tab.send("Page.captureScreenshot", {
                "format": "png",
                "clip": {"x": 0, "y": 0, "width": css.get("clientWidth", 1280), "height": css.get("clientHeight", 800), "scale": quality_scale},
            }, timeout=30)
        return [
            {"type": "text", "text": f"Screenshot of '{tab_title}' at scale {quality_scale}"},
            {"type": "image", "data": res["data"], "mimeType": "image/png"},
        ]

    @reg.add(
        "screen_capture",
        "Capture the full gamescope display (Steam UI, games, overlays: exactly what the screen shows) as a JPEG. "
        "Uses gamescope's PipeWire video node, so it works without a physical display attached.",
    )
    async def screen_capture() -> list[dict[str, Any]]:
        if capturer is None:
            raise CaptureUnavailable("screen capture not configured")
        frame = await capturer.grab()
        stats = capturer.stats()
        return [
            {"type": "text", "text": f"Display frame {stats.get('width')}x{stats.get('height')}, {len(frame)} bytes"},
            {"type": "image", "data": base64.b64encode(frame).decode(), "mimeType": "image/jpeg"},
        ]

    @reg.add("stream_status", "Report the live screen stream state: running, fps, bitrate, resolution, viewer count, errors.")
    async def stream_status() -> dict[str, Any]:
        if capturer is None:
            return {"available": False}
        return capturer.stats()

    @reg.add(
        "toast",
        "Show a Decky toast notification in the Steam UI.",
        {"properties": {"title": {"type": "string"}, "body": {"type": "string"}, "duration_ms": {"type": "integer", "default": 5000}},
         "required": ["title", "body"]},
    )
    async def toast(title: str, body: str, duration_ms: int = 5000) -> str:
        js = ("(async () => { const t = window.DeckyPluginLoader?.toaster; if (!t) throw new Error('DeckyPluginLoader.toaster missing');"
              f" t.toast({{ title: {json.dumps(title)}, body: {json.dumps(body)}, duration: {int(duration_ms)} }}); return 'ok'; }})()")
        return await cdp.evaluate_in(None, js)

    @reg.add(
        "write_file",
        "Write a text file on the device (runs as root). Intended for dropping config or test fixtures during development.",
        {"properties": {"path": {"type": "string"}, "content": {"type": "string"}, "mode": {"type": "string", "default": "0644"}},
         "required": ["path", "content"]},
    )
    async def write_file(path: str, content: str, mode: str = "0644") -> str:
        if not os.path.isabs(path):
            raise ValueError("path must be absolute")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            f.write(content)
        os.chmod(path, int(mode, 8))
        return f"wrote {len(content.encode())} bytes to {path}"

    @reg.add(
        "read_file",
        "Read a text file on the device (runs as root). Large files are truncated to max_bytes from the start.",
        {"properties": {"path": {"type": "string"}, "max_bytes": {"type": "integer", "default": 200000}}, "required": ["path"]},
    )
    async def read_file(path: str, max_bytes: int = 200_000) -> dict[str, Any]:
        if not os.path.isabs(path):
            raise ValueError("path must be absolute")
        size = os.path.getsize(path)
        with open(path, "rb") as f:
            data = f.read(max_bytes)
        try:
            text = data.decode()
        except UnicodeDecodeError:
            return {"path": path, "size": size, "base64": base64.b64encode(data).decode(), "truncated": size > max_bytes}
        return {"path": path, "size": size, "text": text, "truncated": size > max_bytes}

    return reg
