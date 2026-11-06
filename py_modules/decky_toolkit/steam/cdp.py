"""Minimal Chrome DevTools Protocol client for Steam's CEF debugger (localhost:8080)."""
import asyncio
import json
from typing import Any, Callable

import aiohttp

CEF_BASE = "http://127.0.0.1:8080"
SHARED_CTX_NAMES = ("SharedJSContext", "Steam Shared Context presented by Valve™", "Steam", "SP")


class CdpError(RuntimeError):
    pass


async def list_targets() -> list[dict[str, Any]]:
    timeout = aiohttp.ClientTimeout(total=3)
    try:
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(f"{CEF_BASE}/json") as res:
                res.raise_for_status()
                return await res.json()
    except (aiohttp.ClientConnectionError, asyncio.TimeoutError) as e:
        raise CdpError(
            f"Steam CEF debugger not reachable at {CEF_BASE}: {e.__class__.__name__}. "
            "Steam is not running, or ~/.steam/steam/.cef-enable-remote-debugging is missing."
        ) from None


async def find_target(title: str | None = None) -> dict[str, Any]:
    targets = await list_targets()
    names = (title,) if title else SHARED_CTX_NAMES
    for name in names:
        for t in targets:
            if t.get("title") == name:
                return t
    # Popup tabs carry a per-user suffix (QuickAccess_uid2), so a bare prefix is enough.
    if title:
        for t in targets:
            if str(t.get("title", "")).startswith(title):
                return t
    raise CdpError(f"No CEF target titled {names!r}; available: {[t.get('title') for t in targets]}")


class Tab:
    """One short-lived DevTools websocket session. Use as an async context manager.

    The long-lived sessions are console.ConsoleCollector's (one per watched target) and
    tools.plugin_tools.PluginTools' (SharedJSContext), which passes `on_event` for CDP events."""

    def __init__(self, target: dict[str, Any], on_event: Callable[[dict[str, Any]], None] | None = None):
        self.target = target
        self.on_event = on_event
        self._session: aiohttp.ClientSession | None = None
        self._ws: aiohttp.ClientWebSocketResponse | None = None
        self._next_id = 0
        self._pending: dict[int, asyncio.Future[dict[str, Any]]] = {}
        self._reader: asyncio.Task[None] | None = None

    async def __aenter__(self) -> "Tab":
        self._session = aiohttp.ClientSession()
        self._ws = await self._session.ws_connect(self.target["webSocketDebuggerUrl"], max_msg_size=64 * 1024 * 1024)
        self._reader = asyncio.create_task(self._read_loop())
        return self

    async def __aexit__(self, *exc: object) -> None:
        if self._reader:
            self._reader.cancel()
        if self._ws:
            await self._ws.close()
        if self._session:
            await self._session.close()

    async def _read_loop(self) -> None:
        assert self._ws is not None
        try:
            async for msg in self._ws:
                if msg.type != aiohttp.WSMsgType.TEXT:
                    continue
                data = json.loads(msg.data)
                if "id" not in data:
                    if self.on_event:
                        self.on_event(data)
                    continue
                fut = self._pending.pop(data["id"], None)
                if fut and not fut.done():
                    fut.set_result(data)
        finally:
            for fut in self._pending.values():
                if not fut.done():
                    fut.set_exception(CdpError("DevTools connection closed"))
            self._pending.clear()

    async def wait_closed(self) -> None:
        if self._reader:
            await asyncio.wait([self._reader])

    async def send(self, method: str, params: dict[str, Any] | None = None, timeout: float = 15) -> dict[str, Any]:
        assert self._ws is not None
        self._next_id += 1
        msg_id = self._next_id
        fut: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
        self._pending[msg_id] = fut
        await self._ws.send_json({"id": msg_id, "method": method, "params": params or {}})
        data = await asyncio.wait_for(fut, timeout)
        if "error" in data:
            raise CdpError(f"{method}: {data['error']}")
        return data.get("result", {})

    async def evaluate(self, expression: str, await_promise: bool = True, timeout: float = 15) -> Any:
        res = await self.send(
            "Runtime.evaluate",
            {
                "expression": expression,
                "awaitPromise": await_promise,
                "returnByValue": True,
                "userGesture": True,
            },
            timeout=timeout,
        )
        if "exceptionDetails" in res:
            details = res["exceptionDetails"]
            text = details.get("exception", {}).get("description") or details.get("text")
            raise CdpError(f"JS exception: {text}")
        return res.get("result", {}).get("value")


async def evaluate_in(title: str | None, expression: str, timeout: float = 15) -> Any:
    target = await find_target(title)
    async with Tab(target) as tab:
        return await tab.evaluate(expression, timeout=timeout)
