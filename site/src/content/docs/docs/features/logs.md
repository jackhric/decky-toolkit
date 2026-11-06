---
title: Logs where you work
description: Stream Decky Loader and plugin logs into output channels in VS Code or VSCodium.
sidebar:
  order: 3
---

- **Show plugin logs** streams your plugin's backend log from `~/homebrew/logs/<plugin>/` into an output
  channel.
- **Show loader logs** streams `journalctl -u plugin_loader`.

Both are in the **Plugin** and **Loader** groups of the Decky sidebar and in the command palette. Build output
from a deploy goes to the **Decky** output channel; a failed build fails the deploy with the compiler's error line.

## From scripts

The same logs are available over HTTP (`GET /api/v1/logs/stream` as SSE, `GET /api/v1/logs/tail`) to paired clients; see the
[API reference](https://github.com/jackhric/decky-toolkit/blob/main/docs/api.md).

MCP clients can use `logs_read` (`source`: `loader`, `plugin`, `steam_console` or `proton`) and `logs_wait`.
