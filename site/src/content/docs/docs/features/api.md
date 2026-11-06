---
title: Scriptable
description: Everything is also available over a small HTTP API and an MCP server for your own tools and coding agents.
sidebar:
  order: 5
---

The extension serves your coding agents and scripts, and everything it can do is also available as a small HTTP API.

## Connect an MCP client

The extension relays MCP from your editor to the connected device. **Decky: Copy MCP URL** gives you a
local address that stays the same across restarts:

```sh
claude mcp add --transport http decky <the copied URL>
```

In VS Code, **Decky: Write MCP config for this workspace** adds the server to `.mcp.json` for you.

Tools are named `<area>_<action>`: `device_info`, `device_run`, `device_activity`, `logs_read`, `logs_wait`,
`plugin_list`, `plugin_install`, `plugin_reload`, `ui_state`, `ui_navigate`, `screen_capture`, `input_key`,
`input_gamepad`, `cef_evaluate` and more; see the
[full reference](https://github.com/jackhric/decky-toolkit/blob/main/docs/reference.md#mcp-tools).

## HTTP

Your own scripts can use the HTTP API too: the versioned client API under `/api/v1`, the same one the editor and the
CLI use (the MCP tools are for agents and change more freely). A script pairs the way the editor does: it asks the device for
access and you approve it in Quick Access → **Decky Toolkit**. The request flow and the full route list are in
[docs/api.md](https://github.com/jackhric/decky-toolkit/blob/main/docs/api.md).

:::caution
Anyone you pair has root on the device. Treat Decky Toolkit as a development tool on a trusted network.
:::
