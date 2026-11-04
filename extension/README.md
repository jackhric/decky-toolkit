# Decky-MCP for VS Code

Companion extension for the [Decky-MCP](../README.md) Decky Loader plugin. It talks to the plugin's
HTTP server on the Steam Deck (port 8765) and gives you, inside VS Code or VSCodium:

- a **Decky** sidebar (Activity Bar icon) that lists your Decks; connect to one and its actions
  (grouped by Screen, Plugin, Loader, Steam and MCP), plugins and a small live preview appear, so
  you never need the command palette,
- a live view of the Deck's display (30 fps MJPEG) in an editor tab,
- one-click build + deploy of the Decky plugin in your workspace, and install of any plugin zip,
- live loader and plugin logs in output channels,
- a JavaScript console for the Steam UI (`SharedJSContext`) and Deck toasts,
- a generated `.mcp.json` so Claude Code and other MCP clients in the workspace can use the Deck.

The Decky-MCP plugin must already be installed and enabled on the Deck.

## Getting started

1. **Click the Decky icon** (the Steam Deck logo) in the Activity Bar. The **Devices** view lists
   your saved Decks. The first time, it contains the Deck from the `decky-mcp.host` setting; use
   the **+** in the view title to add another (see [Adding a Deck](#adding-a-deck)).
2. **Click the Deck** (or its plug icon). If it is not paired yet, pairing starts at once; see
   [Pairing](#pairing). If it is paired, it connects in a second.
3. **Work.** When it is connected, the **Actions**, **Plugins** and **Preview** views appear below
   the list, with the Deck's name in their title bars. The screen panel opens automatically after
   the first connect of a session (setting `decky-mcp.openScreenOnConnect`). Click **Plugin →
   Deploy** in the Actions view to build and install the plugin in your workspace.
4. **Disconnect** with the icon on the device row. The token is kept, so the next connect needs no
   pairing.

The status bar shows `$(vm-connect) <name>` while connected and `$(vm) Decky: not connected`
otherwise. Click it to connect, switch Deck, disconnect, open the screen or add a Deck.

## Sidebar

Before you connect, the sidebar shows only **Devices**. After you connect, **Actions**, **Plugins**
and **Preview** appear below it, all for the connected Deck.

### Devices

Each Deck is shown once, and its row is also the connection state. If the name is the host, the
row shows the host once and the state as the description; otherwise the description is
`host:port · state`.

| State | Icon | Description | Click | Inline icons |
| --- | --- | --- | --- | --- |
| not paired | `key` | `not paired` | connect (pairs first) | Connect, `…` |
| paired, not connected | `vm` | `paired` | connect | Connect, `…` |
| connecting / pairing | spinner | `connecting…` / `pairing…` | none | none |
| connected | `vm-connect` (green) | `connected` | none | Disconnect, `…` |
| unreachable | `warning` (yellow) | `unreachable` | connect (retries) | Connect, `…` |

The `…` icon and the right-click menu hold the rest: **Re-pair** (only for a paired Deck),
**Enter token manually**, **Edit**, **Copy viewer URL** and **Remove**. A connected Deck never
shows Pair, Enter token or Connect as a row or a button. Connect and disconnect live only here.

The view title has **Add device** (+) and **Refresh** (also checks which Decks answer). With no
saved Decks the view shows **Add a Deck**.

### Actions

Everything you can do with the connected Deck, in collapsible groups. Every leaf runs with one
click. Screen, Plugin and Loader start expanded, Steam and MCP collapsed; VS Code remembers what
you expand or collapse.

- **Screen** (description: fps and Mbit/s from `/stream/stats`, polled every 5 s only while the
  view is visible)
  - **Open screen panel**: the live screen in an editor tab.
  - **Open viewer in browser**: opens `http://host:port/viewer`. The browser is paired on its own:
    press **Pair a browser** on the Deck, unless it still has the cookie from an earlier pairing.
  - **Snapshot to file**: fetches `/frame.jpg` and saves it (default name `deck-<timestamp>.jpg`).
- **Plugin** (description: the directory the workspace plugin deploys to)
  - **Deploy**, **Reload backend**, **Show plugin logs** for the workspace folder that contains a
    `plugin.json` (a picker asks if there are several). Without one the group says *no plugin.json
    in workspace*, the actions show *needs a plugin folder*, and clicking one tells you to open
    your plugin folder.
- **Loader**
  - **Restart loader**, **Show loader logs**, **Install plugin zip…** (pick any `.zip`).
- **Steam**
  - **Evaluate JS in Steam UI**, **Toast on Deck**.
- **MCP**
  - **Write MCP config for this workspace**, **Copy MCP URL** (`http://host:port/mcp`),
    **Copy token** (the bearer token; a warning reminds you it is a secret).

The view title has **Open screen** and **Refresh**.

### Plugins

Lists the Deck's plugins (`GET /plugins`, falling back to the `list_plugins` tool) as
`Name  version · dir`; hover for flags, `api_version` and `has_backend`. The inline icons reload a
plugin's backend (`POST /plugins/{dir}/reload`) or open its log. The title bar has **Install
plugin zip…** (pick a `.zip`, upload to `/plugins/install?restart=loader`, wait for the loader) and
Refresh.

### Preview

Fetches one `/frame.jpg` every 1.5 s while the view is visible (well under 1 Mbit/s, instead of the
~40 Mbit/s stream), scaled to the sidebar width. Click **Open full screen view** or the title icon
for the screen panel.

## Remote input

The screen panel can drive the Deck with your keyboard, mouse and a gamepad. Remote input is **off
by default** and is a device-wide switch: it is the same flag as the **Allow remote input** toggle
in the Deck's Decky-MCP panel and the **⌨ Input** button in the browser viewer.

- **Turn it on or off** with the **Input** button in the screen panel toolbar (highlighted while
  on), or run **Decky: Toggle remote input** from the command palette. The extension sends
  `PUT /input/settings`; the panel itself never calls the Deck for this. While input is on the
  status bar shows `$(keyboard)` after the Deck's name. If the Deck cannot inject input, the button
  is disabled and its tooltip gives the reason. A Deck whose plugin predates remote input shows
  *not supported by this device version*.
- **UI mode** (default): click the picture to capture input (a focus outline shows it). Mouse
  moves, clicks and the wheel land on the matching spot of the Deck screen, and keys are sent by
  physical position (`KeyboardEvent.code`), so VS Code keybindings do not fire while the picture
  has focus. Click the toolbar, switch tabs or leave the window to give the keyboard back; every
  held key and button is released.
- **Game mode**: clicking the picture asks for pointer lock and sends relative mouse motion, for
  games with mouse look. Esc releases the pointer. VS Code webviews may refuse pointer lock; the
  toolbar then says *Pointer lock unavailable in this webview, use the browser viewer for Game
  mode*. Use **Open viewer in browser** for Game mode in that case.
- **Gamepad**: a controller connected to this computer is forwarded about 60 times a second while
  the panel has focus ("Gamepad connected" in the toolbar). It appears on the Deck as an Xbox 360
  pad. Whether the Gamepad API works inside a webview depends on the VS Code build.

The panel's WebSocket (`/input`) goes through the same loopback proxy as the stream, which adds the
token during the handshake. The UI/Game switch appears only while input is on.

## Pairing

Pairing starts when you connect to a Deck without a token (or whose token the Deck rejects), or
when you choose **Re-pair**.

1. **Reachability.** The extension calls `GET /health` (no token). If the Deck does not answer, you
   get one error: *Can't reach <name> at host:port. Is the Deck on and Decky-MCP enabled?* with
   **Retry** and **Edit device**. Nothing else happens.
2. **Waiting.** One progress notification: *Pairing with <name>: on the Deck open Quick Access →
   Decky-MCP → Pair a browser. Waiting… 118 s*, with a live countdown and **Cancel**. On the Deck,
   open the Quick Access menu (…), choose Decky-MCP and press **Pair a browser**. The extension polls
   `/pair` every 1.5 s. When the Deck grants the token, it is stored, the Deck becomes connected and
   you see *Paired with <name>* with **Open screen** and **Deploy plugin**.
3. **Timeout.** After 120 s without a press: *Pairing timed out* with **Try again** and **Enter token
   manually**. A Deck whose plugin predates pairing gets **Enter token manually** at once; paste the
   token shown in its Decky-MCP panel.

### Adding a Deck

**Add device** asks for the IP address or hostname (`host:port` also works), then for an optional
name (press Enter to use the host). The port is 8765. A picker then offers **Connect to <name>**,
**Change port (8765)…** and **Not now**. Connect goes straight into the steps above.

## Connection model

- **One state object.** `Connection` holds the saved Decks, the active Deck and its token, the
  session (the connected Deck) and a state per Deck: `unpaired`, `disconnected` (paired),
  `connecting`, `pairing`, `connected` or `unreachable`. The views, status bar, screen panel and
  preview subscribe to its events.
- **Health.** While connected, `/health` is checked every 15 s. If it fails, the Deck shows as
  unreachable but stays the connected Deck, with its token; when it answers again it is connected
  again. Commands such as Deploy need a connected Deck; if there is none they offer to connect.
- **Reconnect.** The connected Deck is remembered. After a window reload the extension reconnects to
  it silently if it answers and the token is still valid.

## Commands

All of these are also in the command palette under the `Decky:` category.

| Command | What it does |
| --- | --- |
| Decky: Connect | Connects to a Deck; pairs first when there is no valid token |
| Decky: Disconnect | Ends the session; keeps the token |
| Decky: Re-pair | Runs pairing again for a Deck |
| Decky: Enter token manually | Paste a token; it is checked with an MCP `tools/list` call |
| Decky: Disconnect and forget token | Forgets the token for the active Deck |
| Decky: Switch device / Add device… / Edit device / Remove device | Connect to another saved Deck, manage saved Decks |
| Decky: Copy viewer URL | Copies `http://host:port/viewer` for a browser |
| Decky: Change host | Changes the active Deck's host/port and writes the `decky-mcp.host`/`port` settings |
| Decky: Open screen | Live screen panel with fps / Mbps / resolution, pause, fit/actual, snapshot and the remote input toggle |
| Decky: Open viewer in browser | Opens `http://host:port/viewer` in the default browser (pair the browser on the Deck) |
| Decky: Snapshot to file | Saves the current `/frame.jpg` with a Save dialog |
| Decky: Toggle remote input | Turns remote keyboard, mouse and gamepad input on or off for the whole Deck (`PUT /input/settings`) |
| Decky: Deploy plugin | `pnpm run build`, zip, `POST /plugins/install?restart=loader`, wait for `/health` |
| Decky: Install plugin zip… | Uploads a plugin zip from disk to `/plugins/install?restart=loader` |
| Decky: Restart loader | `POST /loader/restart` (falls back to the `restart_loader` tool) |
| Decky: Reload plugin | `POST /plugins/{dir}/reload` for one plugin backend |
| Decky: Show loader logs | Streams `journalctl -u plugin_loader` via `/logs/stream` |
| Decky: Show plugin logs | Streams a plugin's log from `~/homebrew/logs/<dir>/` |
| Decky: Evaluate JS in Steam UI | Runs an expression with the `cef_evaluate` tool; result in an info message or the "Decky-MCP Console" output |
| Decky: Toast on Deck | Shows a Decky toast |
| Decky: Write MCP config for this workspace | Adds `mcpServers.decky` to `.mcp.json` in the first workspace folder |
| Decky: Copy MCP URL | Copies `http://host:port/mcp` |
| Decky: Copy token | Copies the bearer token (a secret) |
| Decky: Refresh / Refresh plugins | Re-reads the token and `/health`, checks which Decks answer, reloads the plugin list |

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `decky-mcp.openScreenOnConnect` | `true` | Open the screen panel after the first successful connect of a session |
| `decky-mcp.host` | `10.0.70.18` | Deck IP or hostname. Seeds the first saved Deck; used when the device list is empty |
| `decky-mcp.port` | `8765` | Decky-MCP server port (same rules as `host`) |
| `decky-mcp.pluginDirName` | (empty) | Target dir under `~/homebrew/plugins` for deploy; empty means the workspace folder name |

Saved Decks live in VS Code's global state (`decky-mcp.devices`), so all windows share them.
Tokens are stored per `host:port` in secret storage.

## How it works

- **Token handling.** The token lives in `context.secrets`. Webviews never see it: the extension runs
  a loopback proxy (`127.0.0.1`, random port, random path prefix) that adds the
  `Authorization: Bearer` header and strips browser `Origin`/`Cookie` headers before forwarding to
  the Deck. WebSocket upgrades (`/input`) are forwarded the same way. The screen panel and the
  preview only know the proxy URL, and their CSP allows only that origin (plus its `ws:` form for
  the screen panel) and `blob:`. The one place the token leaves secret storage is `.mcp.json`, after a
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

Install the packaged build with `code --install-extension decky-mcp-0.4.0.vsix`.

### Smoke test (no device)

`scripts/smoke.mjs` loads the bundled extension against a stub `vscode` module and a fake device:

```sh
pnpm run smoke
```

It evaluates the `when` clauses in `package.json` against the context keys the extension sets, and
checks which views are visible before and after connecting, the device rows for an unpaired, a
paired and a connected Deck and the menus on them, the view title buttons, and the Actions tree
(exactly Screen, Plugin, Loader, Steam and MCP with their leaves, with and without a `plugin.json`
in the workspace). It also checks that Connect on an unpaired Deck starts pairing (fake `/pair`
answers 403, then a token), the reachability error with Retry, the pairing timeout (with a short
timeout), the 15 s health check going unreachable and back, Add device, snapshot, Copy MCP URL /
token and Open viewer, and the remote input toggle (screen panel message, palette command, status
bar indicator, unavailable and unsupported devices).

### Headless integration check

`scripts/dev-check.mjs` exercises the proxy, client and zip code against a live device without VS
Code:

```sh
DECKY_TOKEN_FILE=~/deck-token node scripts/dev-check.mjs [host] [port]
```

It checks `/health`, `/stream.mjpeg` (at least two thirds of the device's fps cap for 5 s),
`/plugins` and `/frame.jpg` through the proxy, runs `media/screen.js` in a minimal DOM against the
proxy and compares its fps readout with `/stream/stats` (within 10 %), calls MCP `tools/list`
through the client, opens a WebSocket to `/input` through the proxy and expects close code 4003
(input must be off on the Deck; the check never turns it on), probes the newer routes, and validates a staged zip with `unzip -t`. The
stream checks need a screen that changes: gamescope sends no frames while the screen is static.
