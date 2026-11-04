"""Tool registry and the result envelope shared by every MCP tool."""
import json
import logging
import traceback
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Awaitable, Callable

from .. import audit, cdp
from ..capture import CaptureUnavailable, ScreenCapturer
from ..input.service import InputDisabled, InputService, InputUnavailable

if TYPE_CHECKING:
    from ..controllers import ControllerService
    from ..ui import UiNavigator

ToolFn = Callable[..., Awaitable[Any]]
# Exceptions that are expected, user-facing failures: reported without a traceback.
EXPECTED_ERRORS: tuple[type[BaseException], ...] = (ValueError, FileNotFoundError, PermissionError, cdp.CdpError,
                                                     CaptureUnavailable, InputDisabled, InputUnavailable)
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
        self.log = logging.getLogger("decky_mcp.tools")
        self.audited: set[str] = set(audit.AUDITED_TOOLS)

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
        if audit.is_audited(name, self.audited):
            self.log.info(audit.tool_line(name, arguments, tool.input_schema.get("properties", {})))
        try:
            result = await tool.fn(**arguments)
        except TypeError as e:
            # Bad/missing arguments surface as a tool error so the agent can self-correct.
            return error_result(f"Invalid arguments for {name}: {e}")
        except EXPECTED_ERRORS as e:
            return error_result(f"{type(e).__name__}: {e}")
        except Exception as e:  # noqa: BLE001
            return error_result(f"{type(e).__name__}: {e}\n{traceback.format_exc()}")
        return ok_result(result)


def ok_result(result: Any) -> dict[str, Any]:
    if isinstance(result, list) and result and all(isinstance(c, dict) and c.get("type") in _CONTENT_TYPES for c in result):
        return {"content": result, "isError": False}
    text = result if isinstance(result, str) else json.dumps(result, indent=2, ensure_ascii=False, default=str)
    return {"content": [{"type": "text", "text": text}], "isError": False}


def error_result(text: str) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": text}], "isError": True}


def build_registry(capturer: ScreenCapturer | None = None, input_service: InputService | None = None,
                   controllers: "ControllerService | None" = None, navigator: "UiNavigator | None" = None) -> ToolRegistry:
    from . import cef, controllers as controller_tools, input, plugin_api, plugins, screen, system, ui

    if controllers is None and input_service is not None:
        from ..controllers import ControllerService
        controllers = ControllerService(input_service, input_service.log)

    reg = ToolRegistry()
    system.register(reg)
    plugins.register(reg)
    cef.register(reg)
    plugin_api.register(reg)
    screen.register(reg, capturer)
    input.register(reg, input_service, capturer)
    controller_tools.register(reg, controllers)
    ui.register(reg, navigator, capturer)
    return reg
