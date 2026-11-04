"""Controller tools: Steam Input's controller list and virtual Xbox 360 pads."""
from typing import Any

from ..controllers import ControllerService
from ..input.service import InputUnavailable
from . import ToolRegistry


def register(reg: ToolRegistry, service: ControllerService | None) -> None:
    def svc() -> ControllerService:
        if service is None:
            raise InputUnavailable("controller service not configured")
        return service

    @reg.add(
        "list_controllers",
        "Gamepads as Steam Input sees them (window.ControllerStore in the Steam UI), merged with kernel evdev "
        "detail. Each entry: id, name, kind physical|virtual, virtual_id (ours), vendor/product, device "
        "(/dev/input/eventN), seen_by_steam, steam {type, slot, name, index, type_name, active} or null when "
        "Steam Input does not list it. Also: virtual (our pads), input_enabled, steam_available.",
    )
    async def list_controllers() -> dict[str, Any]:
        return await svc().snapshot()

    @reg.add(
        "add_virtual_controller",
        "Plug in a virtual Xbox 360 pad (uinput 045e:028e) that Steam Input picks up like a real controller. "
        "Returns once Steam Input lists it (up to 3 s; otherwise the pad is removed and this fails). Stays until "
        "remove_virtual_controller (max 4). Drive it with input_gamepad(pad=<id>) (needs input enabled).",
        {"properties": {"name": {"type": "string", "description": "Label for the pad (default 'Virtual pad N')."}}},
    )
    async def add_virtual_controller(name: str | None = None) -> dict[str, Any]:
        return await svc().add_virtual(name)

    @reg.add(
        "remove_virtual_controller",
        "Unplug a virtual pad by id (from add_virtual_controller or list_controllers; 'auto' is the implicit "
        "pad input_gamepad creates).",
        {"properties": {"id": {"type": "string"}}, "required": ["id"]},
    )
    async def remove_virtual_controller(id: str) -> dict[str, Any]:  # noqa: A002
        if not svc().remove_virtual(id):
            raise ValueError(f"no virtual gamepad {id!r}; have {', '.join(p.id for p in svc().input.pads()) or 'none'}")
        return {"removed": id}
