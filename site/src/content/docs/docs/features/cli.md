---
title: CLI and MCP
description: Pair from a terminal, give Claude Code or any MCP client your SteamOS device, and deploy plugins with the decky-toolkit CLI.
sidebar:
  order: 4
---

The `decky-toolkit` command line tool pairs your computer with the device, gives coding agents the device's tools
over MCP, and deploys plugins without VS Code. It needs Node.js 20 or newer.

## Pair

```sh
npx -y decky-toolkit pair
```

It searches your network for the device, prints a four-digit code and waits. Approve the same code on the device in
Quick Access → **Decky Toolkit**. A device on another network is paired by address:
`npx -y decky-toolkit pair 192.168.1.50`.

The CLI and the VS Code extension share one pairing per computer. Pair in either one and both work.

## Connect an agent

Add the device to Claude Code:

```sh
claude mcp add decky -- npx -y decky-toolkit mcp
```

Or let VS Code do it: run **Decky: Write MCP config for this workspace**. It adds this to `.mcp.json` in your
workspace:

```json
{
  "mcpServers": {
    "decky": { "command": "npx", "args": ["-y", "decky-toolkit", "mcp"] }
  }
}
```

The agent can then see the screen, read logs, deploy and reload your plugin, open Steam pages, press buttons and
run commands on the device. Your plugin can [add its own tools](../plugin-tools/) too.

## Commands

| Command | What it does |
| --- | --- |
| `new [dir]` | Create a plugin from the official template, then install and build it |
| `pair [host]` | Pair this computer with a device |
| `status` | Show the paired device and whether it answers |
| `mcp` | Run the MCP server for an agent |
| `deploy [dir]` | Build if needed, install the plugin and wait until it loads |
| `dev [dir]` | Deploy, then live reload every change until Ctrl-C |
| `call <tool> [json]` | Call one device tool; images are saved with `--out` |
| `forget` | Forget the pairing on this computer |

```text
$ npx -y decky-toolkit status
Identity   /home/me/.config/decky-toolkit/identity.json
Device     steamdeck (192.168.1.50:8765)
Reachable  yes
Plugin     decky-toolkit 0.6.0, api v1, 50 tools
Paired     yes
```

```sh
npx -y decky-toolkit call ui_state
npx -y decky-toolkit call screen_capture --out screen.jpg
```

Run `npx -y decky-toolkit --help` for every option.

## Start a plugin

```sh
npx -y decky-toolkit new my-plugin --name "My Plugin" --deploy
```

This copies [decky-plugin-template](https://github.com/SteamDeckHomebrew/decky-plugin-template), renames it, installs
and builds it, then deploys it and keeps it in sync until Ctrl-C. Options:

- `--variant backend` adds a Python backend, `--variant mcp-tool` an [agent tool](../plugin-tools/)
- `--build vite` builds with Vite instead of the template's Rollup
- `--template latest` uses the template's newest version instead of the tested one
