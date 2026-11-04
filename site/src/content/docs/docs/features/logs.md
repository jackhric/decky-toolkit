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

The same logs are available over HTTP with the device token:

```sh
curl -N -H "Authorization: Bearer $TOKEN" "http://<deck-ip>:8765/logs/stream?plugin=my-plugin"   # SSE
curl -H "Authorization: Bearer $TOKEN" "http://<deck-ip>:8765/logs/tail?source=loader&tail=50"
```

MCP clients can use the `read_plugin_log` and `loader_log` tools.
