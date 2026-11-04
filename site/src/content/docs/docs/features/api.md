---
title: Scriptable
description: Everything is also available over a small HTTP API and an MCP server for your own tools and coding agents.
sidebar:
  order: 5
---

The plugin's server on `http://<deck-ip>:8765` serves the extension and your own scripts.
The same server speaks MCP Streamable HTTP on `/mcp`.

## Connect an MCP client

```sh
claude mcp add --transport http decky http://<deck-ip>:8765/mcp -H "Authorization: Bearer <token>"
```

In VS Code, **Decky: Write MCP config for this workspace** adds the server to `.mcp.json` for you. The token
is shown in the Decky Toolkit panel on the device.

Tools include `decky_status`, `list_plugins`, `install_plugin`, `reload_plugin`, `read_plugin_log`,
`screen_capture`, `input_key`, `input_gamepad`, `ui_navigate`, `cef_evaluate` and more; see the
[full reference](https://github.com/jackhric/decky-toolkit/blob/main/docs/reference.md#mcp-tools).

## HTTP

```sh
curl -H "Authorization: Bearer $TOKEN" -F file=@my-plugin.zip "http://<deck-ip>:8765/plugins/install?restart=loader"
```

A script gets a token the same way the editor does: `POST /pair/request`, approve it on the device, then
long-poll `GET /pair/request/{id}?wait=25` until it returns the token. The full route list is in
[docs/api.md](https://github.com/jackhric/decky-toolkit/blob/main/docs/api.md).

:::caution
Traffic is plain HTTP on your LAN, and anyone with the token has root on the device. Treat Decky Toolkit as a
development tool on a trusted network.
:::
