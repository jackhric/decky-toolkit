# Decky-MCP for VS Code

Companion extension for the [Decky-MCP](../README.md) Decky Loader plugin. It talks to the plugin's
HTTP server on the Steam Deck (port 8765) and gives you, inside VS Code or VSCodium:

- a **Decky** sidebar (Activity Bar icon) that lists your Decks; connect to one and its actions,
  plugins and a small live preview appear, so you never need the command palette,
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
3. **Work.** When it is connected, the **Device**, **Plugins** and **Preview** views appear below the
   list, with the Deck's name in their title bars. The screen panel opens automatically after the
   first connect of a session (setting `decky-mcp.openScreenOnConnect`). Click **Deploy plugin** in
   the Device view to build and install the plugin in your workspace.
4. **Disconnect** with the icon on the device row or in the Device view title. The token is kept,
   so the next connect needs no pairing.

The status bar shows `$(vm-connect) <name>` while connected and `$(vm) Decky: not connected`
otherwise. Click it to connect, switch Deck, disconnect, add a Deck or change the sidebar layout.

## Sidebar layouts

There are three layouts so you can compare them. Change the layout with the **gear** icon in the
title bar of any Decky view, with **Decky: Switch sidebar layout**, from the status bar picker, or
with the `decky-mcp.sidebarLayout` setting. The sidebar changes at once; no window reload.

| Layout | Before you connect | After you connect |
| --- | --- | --- |
| `devices-first` (default) | **Devices**: one row per Deck (name, address, state) | **Devices** plus **Device** (Screen row and the 8 actions), **Plugins** and **Preview**, all for the connected Deck |
| `unified` | **Decky**: one row per Deck; a Deck expands to Connect / Edit / Remove | The connected Deck expands to **Screen**, **Plugins**, **Actions** and **Settings**; **Preview** below |
| `classic` | **Device** with the pairing buttons, **Plugins**, **Preview** (the 0.2 sidebar) | **Device**: Devices group, connection row, Screen, Actions; **Plugins**; **Preview** |

### Device rows (`devices-first` and `unified`)

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
shows Pair, Enter token or Connect as a row or a button.

The Devices view title has **Add device** (+), **Refresh** (also checks which Decks answer) and the
layout gear. With no saved Decks the view shows **Add a Deck**.

### Device, Plugins and Preview views

- **Device** (`devices-first`): the **Screen** row (fps / Mbit/s from `/stream/stats`, polled every
  5 s only while the view is visible; click to open the screen panel) and the actions Deploy plugin,
  Restart loader, Reload plugin, Loader logs, Plugin logs, Evaluate JS in Steam UI, Toast on Deck and
  Write MCP config. The title bar has Open screen and Disconnect.
- **Plugins** lists the Deck's plugins (`GET /plugins`, falling back to the `list_plugins` tool) as
  `Name  version · dir`; hover for flags, `api_version` and `has_backend`. The inline icons reload a
  plugin's backend (`POST /plugins/{dir}/reload`) or open its log. The title bar has
  **Install plugin zip…** (pick a `.zip`, upload to `/plugins/install?restart=loader`, wait for the
  loader) and Refresh.
- **Preview** fetches one `/frame.jpg` every 1.5 s while the view is visible (well under 1 Mbit/s,
  instead of the ~40 Mbit/s stream), scaled to the sidebar width.

In `unified` the same Screen row, plugin list (with the same inline icons) and actions are groups
under the connected Deck, and **Settings** holds Edit, Copy viewer URL and Remove.

### Classic

Unchanged from 0.2: while the active Deck is not paired, the Device view shows **Pair with device**,
**Enter token manually**, **Switch device**, **Add device** and **Change host**. When paired it shows
a Devices group (click another Deck to make it active), the `host:port` connection row (Pair, Enter
token, Change host, Disconnect), Screen and Actions. Pairing uses the same flow as below. Here
**Disconnect** forgets the token.

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
  again. Commands such as Deploy need a connected Deck in `devices-first` and `unified`; if there is
  none they offer to connect.
- **Reconnect.** The connected Deck is remembered. After a window reload the extension reconnects to
  it silently if it answers and the token is still valid.

## Commands

All of these are also in the command palette under the `Decky:` category.

| Command | What it does |
| --- | --- |
| Decky: Connect | Connects to a Deck; pairs first when there is no valid token |
| Decky: Disconnect | Ends the session; keeps the token |
| Decky: Re-pair | Runs pairing again for a Deck |
| Decky: Pair with device | Pairing for the active Deck (classic) |
| Decky: Enter token manually | Paste a token; it is checked with an MCP `tools/list` call |
| Decky: Disconnect and forget token | Forgets the token for the active Deck |
| Decky: Switch sidebar layout | Picks `devices-first`, `unified` or `classic` |
| Decky: Switch device / Add device… / Edit device / Remove device | Manage saved Decks |
| Decky: Copy viewer URL | Copies `http://host:port/viewer` for a browser |
| Decky: Change host | Changes the active Deck's host/port and writes the `decky-mcp.host`/`port` settings |
| Decky: Open screen | Live screen panel with fps / Mbps / resolution, pause, fit/actual, snapshot |
| Decky: Deploy plugin | `pnpm run build`, zip, `POST /plugins/install?restart=loader`, wait for `/health` |
| Decky: Install plugin zip… | Uploads a plugin zip from disk to `/plugins/install?restart=loader` |
| Decky: Restart loader | `POST /loader/restart` (falls back to the `restart_loader` tool) |
| Decky: Reload plugin | `POST /plugins/{dir}/reload` for one plugin backend |
| Decky: Show loader logs | Streams `journalctl -u plugin_loader` via `/logs/stream` |
| Decky: Show plugin logs | Streams a plugin's log from `~/homebrew/logs/<dir>/` |
| Decky: Evaluate JS in Steam UI | Runs an expression with the `cef_evaluate` tool; result in an info message or the "Decky-MCP Console" output |
| Decky: Toast on Deck | Shows a Decky toast |
| Decky: Write MCP config for this workspace | Adds `mcpServers.decky` to `.mcp.json` in the first workspace folder |
| Decky: Refresh / Refresh plugins | Re-reads the token and `/health`, checks which Decks answer, reloads the plugin list |

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `decky-mcp.sidebarLayout` | `devices-first` | `devices-first`, `unified` or `classic`; applies immediately |
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

Install the packaged build with `code --install-extension decky-mcp-0.3.0.vsix`.

### Smoke test (no device)

`scripts/smoke.mjs` loads the bundled extension against a stub `vscode` module and a fake device:

```sh
pnpm run smoke
```

It evaluates the `when` clauses in `package.json` against the context keys the extension sets, and
checks for each layout which views are visible, the device rows for an unpaired, a paired and a
connected Deck, and the menus on them. It also checks that Connect on an unpaired Deck starts
pairing (fake `/pair` answers 403, then a token), the reachability error with Retry, the pairing
timeout (with a short timeout), the 15 s health check going unreachable and back, Add device, and
that switching layouts writes the setting, sets `decky-mcp.layout` and refreshes every view. The
classic checks from 0.2 still run in the `classic` layout.

### Headless integration check

`scripts/dev-check.mjs` exercises the proxy, client and zip code against a live device without VS
Code:

```sh
DECKY_TOKEN_FILE=~/deck-token node scripts/dev-check.mjs [host] [port]
```

It checks `/health`, `/stream.mjpeg` (at least two thirds of the device's fps cap for 5 s),
`/plugins` and `/frame.jpg` through the proxy, runs `media/screen.js` in a minimal DOM against the
proxy and compares its fps readout with `/stream/stats` (within 10 %), calls MCP `tools/list`
through the client, probes the newer routes, and validates a staged zip with `unzip -t`. The
stream checks need a screen that changes: gamescope sends no frames while the screen is static.
