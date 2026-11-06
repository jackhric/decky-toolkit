"""Tool registry and the result envelope shared by every MCP tool."""
import hashlib
import inspect
import json
import logging
import traceback
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Awaitable, Callable, Container

from .. import errors
from ..server import audit
from ..steam.plugin_tools import PluginToolError

if TYPE_CHECKING:
    from ..services import Services
    from ..steam.plugin_tools import PluginTools

ToolFn = Callable[..., Awaitable[Any]]
_CONTENT_TYPES = {"text", "image", "audio", "resource", "resource_link"}


@dataclass
class Tool:
    name: str
    description: str
    input_schema: dict[str, Any]
    fn: ToolFn


class ToolRegistry:
    def __init__(self) -> None:
        self._tools: dict[str, Tool] = {}
        # McpServer points this at the plugin logger; audit lines go there.
        self.log = logging.getLogger("decky_toolkit.tools")
        self.audited: set[str] = set(audit.AUDITED_TOOLS)
        # Tools other plugins register from their frontend; set by build_registry.
        self.plugin_tools: "PluginTools | None" = None

    def __len__(self) -> int:
        return len(self.describe())

    def names(self) -> list[str]:
        return list(self._tools)

    def add(self, name: str, description: str, input_schema: dict[str, Any] | None = None) -> Callable[[ToolFn], ToolFn]:
        def deco(fn: ToolFn) -> ToolFn:
            schema = input_schema or {"type": "object", "properties": {}}
            schema.setdefault("type", "object")
            schema.setdefault("properties", {})
            self._tools[name] = Tool(name, description, schema, fn)
            return fn
        return deco

    def describe(self) -> list[dict[str, Any]]:
        own = [{"name": t.name, "description": t.description, "inputSchema": t.input_schema} for t in self._tools.values()]
        return own + (self.plugin_tools.describe() if self.plugin_tools else [])

    def fingerprint(self) -> str:
        """Changes whenever a tool, its description or its schema does; clients compare it to refresh their list."""
        blob = json.dumps(self.describe(), sort_keys=True, ensure_ascii=False).encode()
        return hashlib.sha256(blob).hexdigest()[:16]

    async def call(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        tool = self._tools.get(name)
        if tool is None:
            plugins = self.plugin_tools
            plugin_tool = plugins.get(name) if plugins else None
            if plugins is None or plugin_tool is None:
                raise ValueError(f"Unknown tool: {name}")
            if problem := schema_problem(plugin_tool.input_schema, arguments):
                return error_result(f"Invalid arguments for {name}: {problem}. {describe_arguments(plugin_tool.input_schema)}")
            # Code from another plugin running as root: always audited.
            self.log.info(audit.tool_line(name, arguments, plugin_tool.input_schema.get("properties", {})))
            try:
                value = await plugins.call(plugin_tool, arguments)
            except PluginToolError as e:
                return error_result(str(e))
            result = ok_result(value)
            if plugin_tool.output_schema and isinstance(value, dict):
                result["structuredContent"] = value
            return result
        if problem := argument_problem(tool, arguments):
            # Checked against the schema up front, so a TypeError inside the tool is reported as the bug it is.
            return error_result(f"Invalid arguments for {name}: {problem}. {describe_arguments(tool.input_schema)}")
        if audit.is_audited(name, self.audited):
            self.log.info(audit.tool_line(name, arguments, tool.input_schema.get("properties", {})))
        try:
            result = await tool.fn(**arguments)
        except errors.EXPECTED as e:
            return error_result(f"{type(e).__name__}: {e}")
        except Exception as e:  # noqa: BLE001
            return error_result(f"{type(e).__name__}: {e}\n{traceback.format_exc()}")
        return ok_result(result)


def schema_problem(schema: dict[str, Any], arguments: dict[str, Any], defaulted: Container[str] = ()) -> str | None:
    """Unknown or missing arguments; unknown ones are refused unless the schema explicitly allows extra properties."""
    props = schema.get("properties", {})
    unknown = [] if schema.get("additionalProperties") not in (None, False) else [k for k in arguments if k not in props]
    if unknown:
        return f"unknown argument{'s' if len(unknown) > 1 else ''} {', '.join(repr(k) for k in unknown)}"
    missing = [k for k in schema.get("required", []) if k not in arguments and k not in defaulted]
    if missing:
        return f"missing required {', '.join(repr(k) for k in missing)}"
    return None


def argument_problem(tool: Tool, arguments: dict[str, Any]) -> str | None:
    # A required argument the function has a default for is the tool's to explain (e.g. "needs confirm: true").
    params = inspect.signature(tool.fn).parameters
    defaulted = {k for k, p in params.items() if p.default is not inspect.Parameter.empty}
    if problem := schema_problem(tool.input_schema, arguments, defaulted):
        return problem
    try:
        inspect.signature(tool.fn).bind(**arguments)
    except TypeError as e:
        return str(e)
    return None


def describe_arguments(schema: dict[str, Any]) -> str:
    props = schema.get("properties", {})
    if not props:
        return "It takes no arguments."
    required = set(schema.get("required", []))
    parts = []
    for k, v in props.items():
        kind = "|".join(map(str, v["enum"])) if "enum" in v else v.get("type", "any")
        parts.append(f"{k} ({kind}{', required' if k in required else ''})")
    return "Arguments: " + "; ".join(parts) + "."


def ok_result(result: Any) -> dict[str, Any]:
    if isinstance(result, list) and result and all(isinstance(c, dict) and c.get("type") in _CONTENT_TYPES for c in result):
        return {"content": result, "isError": False}
    text = result if isinstance(result, str) else json.dumps(result, indent=2, ensure_ascii=False, default=str)
    return {"content": [{"type": "text", "text": text}], "isError": False}


def error_result(text: str) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": text}], "isError": True}


def build_registry(services: "Services") -> ToolRegistry:
    from ..steam.ui import UiInspector
    from . import (activity, apps, cef, controllers, games, input, logs, perf, plugin_api, plugins, record, screen,
                   shell, system, ui)

    s = services
    inspector = UiInspector(s.ui)
    orient = ui.Orientation(inspector, s.activity)
    reg = ToolRegistry()
    system.register(reg)
    plugins.register(reg, s.events)
    cef.register(reg)
    logs.register(reg, s.console)
    plugin_api.register(reg)
    screen.register(reg, s.capturer, orient)
    input.register(reg, s.input, s.capturer, orient)
    controllers.register(reg, s.controllers)
    ui.register(reg, inspector, s.capturer, orient)
    apps.register(reg, s.apps)
    games.register(reg, s.apps)
    record.register(reg, s.capturer)
    perf.register(reg, s.perf)
    shell.register(reg)
    activity.register(reg, s.activity, s.input, s.capturer, s.ui)
    reg.plugin_tools = s.plugin_tools
    s.plugin_tools.set_builtin(reg.names())
    return reg
