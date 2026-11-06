# decky-toolkit

Command line companion for [Decky Toolkit](https://jackhric.github.io/decky-toolkit/), the Decky Loader plugin that lets
coding agents inspect and control a Steam Deck (or any SteamOS / Bazzite device) while you develop Decky plugins.

The CLI pairs your computer with the device, gives Claude Code (or any MCP client) the device's tools over stdio,
and installs Decky plugins on it from your checkout.

## Setup

Install the Decky Toolkit plugin on the device first (Decky → Developer → Install Plugin from URL, see the
[docs](https://jackhric.github.io/decky-toolkit/)). Then, on your computer:

```sh
npx decky-toolkit pair
claude mcp add decky -- npx -y decky-toolkit mcp
```

`pair` searches the local network for the device (or takes its address: `npx decky-toolkit pair 192.168.1.50`),
prints a four-digit code and waits. Check that the device shows the same code and approve it in the Decky Toolkit panel.

Needs Node.js 20 or newer.

## Commands

| Command | What it does |
| --- | --- |
| `pair [host[:port]] [--name <name>]` | Pair this computer with a device. Without a host it searches the local network. |
| `status [--json]` | Show the paired device, whether it answers and whether it still accepts this computer. |
| `mcp` | Run an MCP server over stdio: the device's tools plus `plugin_deploy` and `device_status`. |
| `deploy [dir] [--restart none\|plugin\|loader]` | Install the Decky plugin in `dir` (default: the current folder) on the device and wait until it is loaded. Run the plugin's build first. |
| `dev [dir] [--no-build]` | Develop with live reload until Ctrl-C: runs the plugin's `watch` script, deploys once, then pushes each changed file and reloads the plugin in place. A bundle change reloads only the frontend (the backend keeps running), a Python change restarts the backend, a `plugin.json` or `package.json` change deploys again. You stay on the plugin's panel or page, and load errors are shown with `src/` positions. |
| `call <tool> [json-args] [--out <file>]` | Call one device tool, for example `call screen_capture --out screen.jpg`. Text is printed, images are saved. |
| `forget` | Forget the pairing on this computer. Remove the client in the device's Decky Toolkit panel too. |

Exit codes: 0 success, 1 failure, 2 wrong usage.

## Where the pairing lives

One pairing per computer, in `~/.config/decky-toolkit/identity.json` (`$XDG_CONFIG_HOME/decky-toolkit` if set,
`%APPDATA%\decky-toolkit` on Windows). Keep it private: it lets its holder control the device.

The CLI works alongside the [VS Code extension](https://marketplace.visualstudio.com/items?itemName=jackhric.decky-toolkit):
both use the same pairing, so pairing in one is enough for the other.

## License

MIT
