# Decky-MCP for VS Code

Companion extension for the [Decky-MCP](../README.md) Decky Loader plugin. It talks to the plugin's
HTTP server on the Steam Deck (port 8765) and gives you, inside VS Code or VSCodium:

- a live view of the Deck's display (30 fps MJPEG) in an editor tab,
- one-command build + deploy of the Decky plugin in your workspace,
- live loader and plugin logs in output channels,
- a JavaScript console for the Steam UI (`SharedJSContext`) and Deck toasts,
- a generated `.mcp.json` so Claude Code and other MCP clients in the workspace can use the Deck.

The Decky-MCP plugin must already be installed and enabled on the Deck.

## Setup

1. Set `decky-mcp.host` to the Deck's IP (and `decky-mcp.port` if you changed it).
2. Run **Decky: Pair with device**, then press **Pair a browser** in the Decky-MCP Quick Access
   panel on the Deck within 120 s. The extension polls `GET /pair`, stores the token in VS Code's
   secret storage (per host:port) and shows the device version.
   On a device whose plugin predates `/pair`, use **Decky: Enter token manually** and paste the token
   from the Quick Access panel.
3. Run **Decky: Open screen** or click the `Decky: <host>` status bar item.

## Commands

| Command | What it does |
| --- | --- |
| Decky: Pair with device | Polls `/pair` every 2 s for up to 120 s and stores the token |
| Decky: Enter token manually | Paste a token; it is checked with an MCP `tools/list` call |
| Decky: Disconnect | Forgets the token for the configured host:port |
| Decky: Open screen | Live screen panel with fps / Mbit/s / resolution, pause, fit/actual, snapshot |
| Decky: Deploy plugin | `pnpm run build`, zip, `POST /plugins/install?restart=loader`, wait for `/health` |
| Decky: Restart loader | `POST /loader/restart` (falls back to the `restart_loader` tool) |
| Decky: Reload plugin | `POST /plugins/{dir}/reload` for one plugin backend |
| Decky: Show loader logs | Streams `journalctl -u plugin_loader` via `/logs/stream` |
| Decky: Show plugin logs | Streams a plugin's log from `~/homebrew/logs/<dir>/` |
| Decky: Evaluate JS in Steam UI | Runs an expression with the `cef_evaluate` tool; result in an info message or the "Decky-MCP Console" output |
| Decky: Toast on Deck | Shows a Decky toast |
| Decky: Write MCP config for this workspace | Adds `mcpServers.decky` to `.mcp.json` in the first workspace folder |

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `decky-mcp.host` | `10.0.70.18` | Deck IP or hostname |
| `decky-mcp.port` | `8765` | Decky-MCP server port |
| `decky-mcp.pluginDirName` | (empty) | Target dir under `~/homebrew/plugins` for deploy; empty means the workspace folder name |

## How it works

- **Token handling.** The token lives in `context.secrets`. Webviews never see it: the extension runs
  a loopback proxy (`127.0.0.1`, random port, random path prefix) that adds the
  `Authorization: Bearer` header and strips browser `Origin`/`Cookie` headers before forwarding to
  the Deck. The screen panel only knows the proxy URL, and its CSP allows only that origin and
  `blob:`. The one place the token leaves secret storage is `.mcp.json`, after a confirmation.
- **Deploy** stages the same files as `scripts/deploy.sh` (`dist`, `plugin.json`, `package.json`,
  `main.py`, `LICENSE`, `README.md`, `defaults`, `py_modules`, `static`, plus `bin` if present,
  without `__pycache__`), zips them under a single `<dirname>/` folder with a built-in zip writer and
  uploads the zip. Build output goes to the "Decky-MCP Deploy" output channel.
- **Older devices.** If `/logs/stream` is missing, logs fall back to polling the `loader_log` /
  `read_plugin_log` MCP tools every 3 s and print only new lines. Deploy and reload need a device
  plugin with `/plugins/install` and `/plugins/{dir}/reload`; without them you get an error asking
  you to update the device plugin.

## Development

```sh
cd extension
pnpm install
pnpm run build        # esbuild → dist/extension.js
pnpm run typecheck    # tsc --noEmit
npx @vscode/vsce package --no-dependencies   # → decky-mcp-<version>.vsix
```

Run it in the Extension Development Host: run `pnpm run build`, open the `extension/` folder in VS
Code and press <kbd>F5</kbd> (launch config "Run Decky-MCP extension"), then open your Decky plugin
folder in the new window. Or from a shell:

```sh
pnpm run build
code --extensionDevelopmentPath="$PWD" /path/to/your/decky-plugin
```

(`codium` works the same way.) Use `pnpm run watch` to rebuild on save, then run
"Developer: Reload Window" in the development host.

Install the packaged build with `code --install-extension decky-mcp-0.1.0.vsix`.

### Headless integration check

`scripts/dev-check.mjs` exercises the proxy, client and zip code against a live device without VS
Code:

```sh
DECKY_TOKEN_FILE=~/deck-token node scripts/dev-check.mjs [host] [port]
```

It checks `/health` and `/stream.mjpeg` (at least 100 parts in 5 s) through the proxy, MCP
`tools/list` through the client, probes the newer routes, and validates a staged zip with `unzip -t`.
