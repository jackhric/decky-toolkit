# Decky-MCP for VS Code

Companion extension for the [Decky-MCP](../README.md) Decky Loader plugin. It talks to the plugin's
HTTP server on the Steam Deck (port 8765) and gives you, inside VS Code or VSCodium:

- a **Decky** sidebar (Activity Bar icon) with your saved Decks, connection state, plugins and a
  small live preview, so you never need the command palette,
- a live view of the Deck's display (30 fps MJPEG) in an editor tab,
- one-click build + deploy of the Decky plugin in your workspace, and install of any plugin zip,
- live loader and plugin logs in output channels,
- a JavaScript console for the Steam UI (`SharedJSContext`) and Deck toasts,
- a generated `.mcp.json` so Claude Code and other MCP clients in the workspace can use the Deck.

The Decky-MCP plugin must already be installed and enabled on the Deck.

## Getting started (sidebar)

1. **Click the Decky icon** (the Steam Deck logo) in the Activity Bar. The sidebar has three views:
   **Device**, **Plugins** and **Preview**.
2. **Pair.** While the active Deck is not paired, the Device view shows a **Pair with device**
   button. Click it, then on the Deck open the Quick Access menu, choose Decky-MCP and press
   **Pair a browser** within two minutes. A notification counts down and can be cancelled. On a
   device whose plugin predates pairing, use **Enter token manually** and paste the token from the
   Decky-MCP panel. If the Deck has another address, use **Change host** or **Add device** first.
3. **Open screen.** After pairing, the notification offers **Open screen**; later, click the
   **Screen** row in the Device view (it shows the live fps and Mbit/s), the screen icon in the view
   title bar, or **Open full screen view** under the Preview.
4. **Deploy.** Expand **Actions** in the Device view and click **Deploy plugin**. The Plugins view
   refreshes once the loader is back.

### Device view

- **Devices**: saved Decks (`name`, `host:port`). The active one has a check mark. Click another to
  switch to it; the inline icons edit or remove a device, **Add device…** adds one. Tokens are stored
  per `host:port`, so switching back to a Deck you paired before needs no new pairing. The status
  bar item `Decky: <name>` opens the same switcher.
- **`host:port`**: *Connected · decky-mcp 0.2.0 · api 1*, *Unreachable* or *Not paired (token
  rejected)*. Expand it for Pair with device, Enter token, Change host and Disconnect.
- **Screen**: fps / Mbit/s from `/stream/stats`, polled every 5 s only while the view is visible.
  Click to open the screen panel.
- **Actions**: Deploy plugin, Restart loader, Reload plugin, Loader logs, Plugin logs, Evaluate JS
  in Steam UI, Toast on Deck, Write MCP config.

The title bar has Pair, Open screen and Refresh; the `…` menu has Switch device and Add device.

### Plugins view

Lists the Deck's plugins (`GET /plugins`, falling back to the `list_plugins` tool) as
`Name  version · dir`; hover for flags, `api_version` and `has_backend`. The inline icons reload a
plugin's backend (`POST /plugins/{dir}/reload`) or open its log. The title bar has
**Install plugin zip…** (pick a `.zip`, upload to `/plugins/install?restart=loader`, wait for the
loader) and Refresh.

### Preview view

Fetches one `/frame.jpg` every 1.5 s while the view is visible (well under 1 Mbit/s, instead of the
~40 Mbit/s stream), scaled to the sidebar width.

## Commands

All of these are also in the command palette under the `Decky:` category.

| Command | What it does |
| --- | --- |
| Decky: Pair with device | Polls `/pair` every 2 s for up to 120 s and stores the token |
| Decky: Enter token manually | Paste a token; it is checked with an MCP `tools/list` call |
| Decky: Disconnect | Forgets the token for the active device |
| Decky: Switch device / Add device… / Edit device / Remove device | Manage saved Decks |
| Decky: Change host | Changes the active device's host/port and writes the `decky-mcp.host`/`port` settings |
| Decky: Open screen | Live screen panel with fps / Mbit/s / resolution, pause, fit/actual, snapshot |
| Decky: Deploy plugin | `pnpm run build`, zip, `POST /plugins/install?restart=loader`, wait for `/health` |
| Decky: Install plugin zip… | Uploads a plugin zip from disk to `/plugins/install?restart=loader` |
| Decky: Restart loader | `POST /loader/restart` (falls back to the `restart_loader` tool) |
| Decky: Reload plugin | `POST /plugins/{dir}/reload` for one plugin backend |
| Decky: Show loader logs | Streams `journalctl -u plugin_loader` via `/logs/stream` |
| Decky: Show plugin logs | Streams a plugin's log from `~/homebrew/logs/<dir>/` |
| Decky: Evaluate JS in Steam UI | Runs an expression with the `cef_evaluate` tool; result in an info message or the "Decky-MCP Console" output |
| Decky: Toast on Deck | Shows a Decky toast |
| Decky: Write MCP config for this workspace | Adds `mcpServers.decky` to `.mcp.json` in the first workspace folder |
| Decky: Refresh / Refresh plugins | Re-reads the token and `/health`, reloads the plugin list |

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `decky-mcp.host` | `10.0.70.18` | Deck IP or hostname. Seeds the first saved device; used when the device list is empty |
| `decky-mcp.port` | `8765` | Decky-MCP server port (same rules as `host`) |
| `decky-mcp.pluginDirName` | (empty) | Target dir under `~/homebrew/plugins` for deploy; empty means the workspace folder name |

Saved devices live in VS Code's global state (`decky-mcp.devices`), so they are shared by all
windows.

## How it works

- **One connection state.** A single `Connection` object holds the active device, token and the
  last `/health` and `/stream/stats` results. The status bar, both trees, the screen panel and the
  preview subscribe to its change events; stats are polled by one timer, only while the Device view
  or the screen panel is visible.
- **Token handling.** The token lives in `context.secrets`. Webviews never see it: the extension runs
  a loopback proxy (`127.0.0.1`, random port, random path prefix) that adds the
  `Authorization: Bearer` header and strips browser `Origin`/`Cookie` headers before forwarding to
  the Deck. The screen panel and the preview only know the proxy URL, and their CSP allows only that
  origin and `blob:`. The one place the token leaves secret storage is `.mcp.json`, after a
  confirmation.
- **Theme.** The screen panel and preview use only VS Code theme colours (`--vscode-*` variables);
  only the video area itself is black.
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

Install the packaged build with `code --install-extension decky-mcp-0.2.0.vsix`.

### Smoke test (no device)

`scripts/smoke.mjs` loads the bundled extension against a stub `vscode` module and a fake device:

```sh
pnpm run smoke
```

It checks that `activate()` registers the Device and Plugins tree views and the Preview webview view,
that every declared command is registered and every menu entry resolves, the device-list seeding,
and the tree contents in the not-paired, paired, unreachable and error states.

### Headless integration check

`scripts/dev-check.mjs` exercises the proxy, client and zip code against a live device without VS
Code:

```sh
DECKY_TOKEN_FILE=~/deck-token node scripts/dev-check.mjs [host] [port]
```

It checks `/health`, `/stream.mjpeg` (at least 100 parts in 5 s), `/plugins` and `/frame.jpg`
through the proxy, runs `media/screen.js` in a minimal DOM against the proxy and compares its fps
readout with `/stream/stats` (within 10 %), calls MCP `tools/list` through the client, probes the
newer routes, and validates a staged zip with `unzip -t`.
