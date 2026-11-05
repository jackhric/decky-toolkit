"""A plugin's backend API: list its callable methods, call one through Decky, check the frontend's calls."""
import ast
import json
import os
import re
from typing import Any

from .. import cdp
from . import ToolRegistry
from .system import plugins_dir

SOURCE_SUFFIXES = (".ts", ".tsx")
MAX_SOURCE_BYTES = 8 * 1024 * 1024
# @decky/api callable("name") / call("name", ...); a bundler may rename callable to callable$1.
_CALL_RE = re.compile(r"(?<![\w$])(callable(?:\$\d+)?|call)\s*(?:<[^<>()]*>)?\s*\(\s*([\"'`])([A-Za-z_]\w*)\2")


def _plugin_path(dirname: str) -> str:
    if not dirname or "/" in dirname or dirname.startswith("."):
        raise ValueError("dir must be a bare plugin directory name")
    path = os.path.join(plugins_dir(), dirname)
    if not os.path.isdir(path):
        raise FileNotFoundError(f"no plugin installed at {path}")
    return path


def _arg(a: ast.arg, default: ast.expr | None, prefix: str = "") -> dict[str, Any]:
    out: dict[str, Any] = {"name": prefix + a.arg}
    if a.annotation is not None:
        out["annotation"] = ast.unparse(a.annotation)
    if default is not None:
        out["default"] = ast.unparse(default)
    return out


def methods_from_source(source: str, filename: str = "main.py") -> list[dict[str, Any]]:
    """Public async methods of `class Plugin`: what loader/call_plugin_method can reach."""
    tree = ast.parse(source, filename)
    cls = next((n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "Plugin"), None)
    if cls is None:
        raise ValueError(f"{filename} has no top-level class Plugin")
    out = []
    for node in cls.body:
        if not isinstance(node, ast.AsyncFunctionDef) or node.name.startswith("_"):
            continue
        a = node.args
        positional = a.posonlyargs + a.args
        defaults: list[ast.expr | None] = [None] * (len(positional) - len(a.defaults)) + list(a.defaults)
        args = [_arg(p, d) for p, d in zip(positional, defaults)]
        if args and args[0]["name"] in ("self", "cls"):
            args = args[1:]
        if a.vararg:
            args.append(_arg(a.vararg, None, "*"))
        args += [_arg(p, d) for p, d in zip(a.kwonlyargs, a.kw_defaults)]
        if a.kwarg:
            args.append(_arg(a.kwarg, None, "**"))
        doc = ast.get_docstring(node)
        out.append({"name": node.name, "args": args, "doc": doc.strip().splitlines()[0] if doc else None,
                    "line": node.lineno})
    return out


def plugin_methods(dirname: str) -> dict[str, Any]:
    path = os.path.join(_plugin_path(dirname), "main.py")
    try:
        with open(path, encoding="utf-8") as f:
            source = f.read()
    except FileNotFoundError:
        raise FileNotFoundError(f"{dirname} has no backend ({path} missing)") from None
    try:
        methods = methods_from_source(source, path)
    except SyntaxError as e:
        raise ValueError(f"{path} does not parse: {e}") from None
    return {"dir": dirname, "file": path, "methods": methods}


def calls_in_text(text: str) -> dict[str, list[int]]:
    found: dict[str, list[int]] = {}
    for m in _CALL_RE.finditer(text):
        found.setdefault(m.group(3), []).append(text.count("\n", 0, m.start()) + 1)
    return found


def _frontend_files(root: str) -> tuple[str, list[str]]:
    src = os.path.join(root, "src")
    files = []
    for base, dirs, names in os.walk(src):
        dirs[:] = [d for d in dirs if d not in ("node_modules", ".git")]
        files += [os.path.join(base, n) for n in sorted(names) if n.endswith(SOURCE_SUFFIXES)]
    if files:
        return "src", sorted(files)
    dist = os.path.join(root, "dist", "index.js")
    if os.path.isfile(dist):
        return "dist", [dist]
    raise FileNotFoundError(f"no frontend found: neither {src}/**/*.ts(x) nor {dist}")


def frontend_check(root: str, methods: list[dict[str, Any]]) -> dict[str, Any]:
    kind, files = _frontend_files(root)
    calls: dict[str, list[str]] = {}
    for path in files:
        with open(path, encoding="utf-8", errors="replace") as f:
            text = f.read(MAX_SOURCE_BYTES)
        for name, lines in calls_in_text(text).items():
            rel = os.path.relpath(path, root)
            calls.setdefault(name, []).extend(f"{rel}:{n}" for n in lines)
    backend = {m["name"] for m in methods}
    return {
        "source": kind,
        "files_scanned": len(files),
        "frontend_calls": {k: calls[k] for k in sorted(calls)},
        "backend_methods": sorted(backend),
        "missing_backend": sorted(set(calls) - backend),
        "unused_backend": sorted(backend - set(calls)),
    }


async def call_plugin_method(plugin: str, method: str, args: list[Any] | None = None, timeout: float = 30) -> dict[str, Any]:
    if not isinstance(plugin, str) or not plugin.strip():
        raise ValueError("plugin must be the plugin.json name, e.g. 'Decky Toolkit'")
    if not isinstance(method, str) or not re.fullmatch(r"[A-Za-z_]\w*", method):
        raise ValueError("method must be a Python identifier")
    if method.startswith("_"):
        raise ValueError("refusing to call a method starting with '_': those are the loader's lifecycle hooks and private helpers")
    if args is None:
        args = []
    if not isinstance(args, list):
        raise ValueError("args must be a list of positional arguments")
    payload = json.dumps([plugin, method, *args])
    # Through the frontend's existing loader connection, as reload_plugin does: :1337's websocket is single-client.
    js = ("(async () => { const B = window.DeckyBackend; if (!B?.call) throw new Error('window.DeckyBackend missing'); "
          f"const a = {payload}; "
          "try { return {ok: true, result: (await B.call('loader/call_plugin_method', ...a)) ?? null}; } "
          "catch (e) { return {ok: false, error: String(e?.message || e), traceback: e?.pythonTraceback ?? null}; } })()")
    res = await cdp.evaluate_in(None, js, timeout=timeout)
    if not isinstance(res, dict):
        raise cdp.CdpError("SharedJSContext returned no result")
    if not res.get("ok"):
        # Decky rejects with a PyError whose message is empty and whose pythonTraceback ends in the exception.
        tb = res.get("traceback")
        error = tb.strip().splitlines()[-1] if tb and tb.strip() else res.get("error")
        out = {"plugin": plugin, "method": method, "ok": False, "error": error}
        if tb:
            out["traceback"] = tb
        return out
    return {"plugin": plugin, "method": method, "ok": True, "result": redact_secrets(res.get("result"))}


def redact_secrets(value: Any) -> Any:
    """Drop `token` keys (and viewer URLs carrying one): Decky Toolkit's own get_status returns the bearer token,
    which must not leak to an MCP client through a plugin call."""
    if isinstance(value, dict):
        return {k: redact_secrets(v) for k, v in value.items()
                if k != "token" and not (k == "viewer_url" and isinstance(v, str) and "token=" in v)}
    if isinstance(value, list):
        return [redact_secrets(v) for v in value]
    return value


def register(reg: ToolRegistry) -> None:
    @reg.add(
        "plugin_methods",
        "List the backend methods a plugin's frontend can call: public async methods of class Plugin in "
        "<dir>/main.py, parsed (not imported). Returns {dir, file, methods: [{name, args: [{name, annotation?, "
        "default?}], doc (first docstring line), line}]}.",
        {"properties": {"dir": {"type": "string", "description": "Plugin directory name, as returned by list_plugins"}},
         "required": ["dir"]},
    )
    async def plugin_methods_tool(dir: str) -> dict[str, Any]:  # noqa: A002 - matches the documented argument name
        return plugin_methods(dir)

    @reg.add(
        "call_plugin_method",
        "Call a plugin's backend method as its frontend would (loader/call_plugin_method through "
        "window.DeckyBackend in SharedJSContext). plugin is the plugin.json name (list_plugins 'name', e.g. "
        "'Decky Toolkit'), args positional. Methods starting with '_' are refused. Returns {ok: true, result} or "
        "{ok: false, error, traceback} with the exception line and the Python traceback Decky returns.",
        {"properties": {
            "plugin": {"type": "string"},
            "method": {"type": "string"},
            "args": {"type": "array", "default": []},
            "timeout": {"type": "number", "default": 30},
        }, "required": ["plugin", "method"]},
    )
    async def call_plugin_method_tool(plugin: str, method: str, args: list[Any] | None = None,
                                      timeout: float = 30) -> dict[str, Any]:
        return await call_plugin_method(plugin, method, args, timeout)

    @reg.add(
        "plugin_frontend_check",
        "Cross-check a plugin's frontend calls against its backend: callable(\"x\") / call(\"x\", ...) names in "
        "<dir>/src/**/*.ts(x) when sources are installed, else in dist/index.js, against plugin_methods. Returns "
        "{source, files_scanned, frontend_calls: {name: [file:line]}, backend_methods, missing_backend (called but "
        "not defined: these fail at runtime), unused_backend}.",
        {"properties": {"dir": {"type": "string"}}, "required": ["dir"]},
    )
    async def plugin_frontend_check(dir: str) -> dict[str, Any]:  # noqa: A002
        root = _plugin_path(dir)
        methods = plugin_methods(dir)["methods"] if os.path.isfile(os.path.join(root, "main.py")) else []
        return {"dir": dir, **frontend_check(root, methods)}
