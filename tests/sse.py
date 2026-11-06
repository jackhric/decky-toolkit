"""Reads `event:`/`data:` frames (and heartbeat comments) from an aiohttp SSE response."""
import json


async def next_event(resp, comments: bool = False) -> tuple[str, dict | None]:
    event, data = "message", None
    while True:
        line = (await resp.content.readline()).decode()
        if not line:
            raise EOFError("stream ended")
        line = line.rstrip("\n")
        if line.startswith(":") and comments:
            return "comment", None
        if line.startswith("event: "):
            event = line[7:]
        elif line.startswith("data: "):
            data = json.loads(line[6:])
        elif line == "" and data is not None:
            return event, data


async def wait_for(resp, name: str, pred=lambda d: True) -> dict:
    while True:
        event, data = await next_event(resp)
        if event == name and pred(data):
            return data
