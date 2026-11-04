# Decky-MCP for VS Code

Companion extension for the [Decky-MCP](../README.md) Decky Loader plugin. It talks to the plugin's
HTTP server on the device (port 8765; any machine running Decky Loader: Steam Deck, SteamOS,
Bazzite, …) and gives you, inside VS Code or VSCodium:

- a **Decky** sidebar (Activity Bar icon) that lists your devices; connect to one and its actions
  (grouped by Screen, Plugin, Loader, Steam and MCP), plugins and a small live preview appear, so
  you never need the command palette,
- a live view of the device's display (30 fps MJPEG) in an editor tab,
- one-click deploy of the Decky plugin open in your workspace: it is detected automatically, built
  only when its sources changed, and reloaded on its own in about a second (no loader restart),
  optionally on every change; plus install of any plugin zip,
- live loader and plugin logs in output channels,
- a JavaScript console for the Steam UI (`SharedJSContext`) and toasts on the device,
- a generated `.mcp.json` so Claude Code and other MCP clients in the workspace can use the device.

The Decky-MCP plugin must already be installed and enabled on the device.

## Getting started

1. **Click the Decky icon** (the Steam Deck logo) in the Activity Bar. The **Devices** view lists
   your saved devices. The first time, it contains the device from the `decky-mcp.host` setting; use
   the **+** in the view title to add another (see [Adding a device](#adding-a-device)).
2. **Click the device** (or its plug icon). If it is not paired yet, pairing starts at once; see
   [Pairing](#pairing). If it is paired, it connects in a second.
3. **Work.** When it is connected, the **Actions**, **Plugins** and **Preview** views appear below
   the list, with the device's name in their title bars. The screen panel opens automatically after
   the first connect of a session (setting `decky-mcp.openScreenOnConnect`). If your workspace is a
   Decky plugin, you are offered to deploy it; afterwards use the `$(rocket) Deploy <name>` button in
   the status bar, <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>D</kbd> (<kbd>Cmd</kbd>+<kbd>Alt</kbd>+<kbd>D</kbd>
   on macOS) or **Plugin → Deploy** in the Actions view. See [Deploy](#deploy).
4. **Disconnect** with the icon on the device row. The token is kept, so the next connect needs no
   pairing.

The status bar shows `$(vm-connect) <name>` while connected and `$(vm) Decky: not connected`
otherwise. Click it to connect, switch device, disconnect, open the screen or add a device.

## Sidebar

Before you connect, the sidebar shows only **Devices**. After you connect, **Actions**, **Plugins**
and **Preview** appear below it, all for the connected device.

### Devices

Each device is shown once, and its row is also the connection state. If the name is the host, the
row shows the host once and the state as the description; otherwise the description is
`host:port · state`.

| State | Icon | Description | Click | Inline icons |
| --- | --- | --- | --- | --- |
| not paired | `key` | `not paired` | connect (pairs first) | Connect, `…` |
| paired, not connected | `vm` | `paired` | connect | Connect, `…` |
| connecting / pairing | spinner | `connecting…` / `waiting for approval · code 4821` | none | none |
| connected | `vm-connect` (green) | `connected` | none | Disconnect, `…` |
| unreachable | `warning` (yellow) | `unreachable` | connect (retries) | Connect, `…` |

The `…` icon and the right-click menu hold the rest: **Re-pair** (only for a paired device),
**Enter token manually**, **Edit**, **Copy viewer URL** and **Remove**. A connected device never
shows Pair, Enter token or Connect as a row or a button. Connect and disconnect live only here.

The view title has **Add device** (+) and **Refresh** (also checks which devices answer). With no
saved devices the view shows **No devices yet. Add a Decky device …** with an **Add device** button.

### Actions

Everything you can do with the connected device, in collapsible groups. Every leaf runs with one
click. Screen, Plugin and Loader start expanded, Steam and MCP collapsed; VS Code remembers what
you expand or collapse.

- **Screen** (description: fps and Mbit/s from `/stream/stats`, polled every 5 s only while the
  view is visible)
  - **Open screen panel**: the live screen in an editor tab.
  - **Open viewer in browser**: opens `http://host:port/viewer`. The browser is paired on its own:
    it shows a **Request access** page and you allow it on the device, unless it still has the
    cookie from an earlier pairing.
  - **Snapshot to file**: fetches `/frame.jpg` and saves it (default name `screen-<timestamp>.jpg`).
- **Plugin** (description: `<name> v<version>` of the detected plugin; the tooltip names its folder
  and the directory it deploys to)
  - **Deploy** (fast, see [Deploy](#deploy)), **Deploy (full restart)**, **Reload backend**, **Show
    plugin logs** and **Auto-deploy on change: On/Off** for the plugin in the workspace (a picker
    asks if there are several). Without one the group says *no plugin.json in workspace*, the
    actions show *needs a plugin folder*, and clicking one tells you to open your plugin folder.
- **Loader**
  - **Restart loader**, **Show loader logs**, **Install plugin zip…** (pick any `.zip`).
- **Steam**
  - **Evaluate JS in Steam UI**, **Toast on device**.
- **MCP**
  - **Write MCP config for this workspace**, **Copy MCP URL** (`http://host:port/mcp`),
    **Copy token** (the bearer token; a warning reminds you it is a secret).

The view title has **Open screen** and **Refresh**.

### Plugins

Lists the device's plugins (`GET /plugins`, falling back to the `list_plugins` tool) as
`Name  version · dir`; hover for flags, `api_version` and `has_backend`. The inline icons reload a
plugin's backend (`POST /plugins/{dir}/reload`) or open its log. The title bar has **Install
plugin zip…** (pick a `.zip`, upload to `/plugins/install?restart=loader`, wait for the loader) and
Refresh.

### Preview

Fetches one `/frame.jpg` every 1.5 s while the view is visible (well under 1 Mbit/s, instead of the
~40 Mbit/s stream), scaled to the sidebar width. Click **Open full screen view** or the title icon
for the screen panel.

## Deploy

The extension looks for Decky plugins in the workspace: every folder with a `plugin.json`, in a
workspace folder or up to two levels below it (not in `node_modules`). It reads the name, author,
flags and `api_version` from `plugin.json` and the version from `package.json`, and installs to
`~/homebrew/plugins/<folder name>` (setting `decky-mcp.pluginDirName` overrides the name). Plugins
are expected to follow the [decky-plugin-template](https://github.com/SteamDeckHomebrew/decky-plugin-template)
layout. Edits to `plugin.json` or `package.json` are picked up at once.

The first time a plugin is found while a device is connected you get *Decky plugin detected:
<name>. Deploy to <device>?* with **Deploy** and **Not now** (once per window). While a device is
connected, the status bar shows `$(rocket) Deploy <name>` (`$(sync~spin)` while a deploy runs).

**One click.** Deploy runs these steps and reports *Deployed <name> in 0.6 s*:

1. **Build, only if needed.** With `decky-mcp.deploy.build` = `auto` (default), `pnpm run build` runs
   only when a file under `src/` (or `tsconfig.json` / `rollup.config.*`) is newer than
   `dist/index.js`, or `dist/index.js` is missing. `main.py` and `py_modules/` never need a build.
   `always` and `never` do what they say. The package manager follows the lockfile
   (`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`; pnpm if there is none). Build output goes
   to the **Decky** output channel; a failed build fails the deploy with the compiler's error line.
2. **Stage and zip** what the template ships: `dist`, `plugin.json`, `package.json`, `main.py`,
   `LICENSE`, `README.md`, `defaults`, `py_modules`, `static`, `bin`, `assets` (those present),
   without `__pycache__`, `*.pyc`, `node_modules` and `.git`. `src/`, `backend/` (the sources of
   `bin/`) and `tests/` stay behind. Executable bits (`bin/*`) are kept.
3. **Upload** to `POST /plugins/install`, which swaps the plugin directory atomically.
4. **Reload only this plugin.** Decky stops the plugin's backend, starts the new one and makes the
   Steam UI import the new `dist/index.js`, so backend and frontend both update without a loader
   restart. The extension waits (up to 10 s) until the loader's log says `Loaded <name>` and the
   plugin's new log file has its first line, then reports the time.

**Fast vs full.** The fast path above takes 0.5-1 s plus the build (measured: 0.6 s with
`dist/` up to date, 2 s with a 1.5 s rollup build). **Deploy (full restart)** restarts Decky Loader
instead, which also reloads the Steam UI: about 9 s until the device answers again and another
~8 s until the plugin's panel is back. Use it when the plugin is not loaded yet or a reload left
it in a bad state. The first deploy of a plugin that is not installed yet always restarts the
loader (Decky only reloads plugins it has loaded).

**The `debug` flag.** It is not needed for fast deploys. The template sets it, and with it the
loader's own file watcher reloads the plugin after every install, normally twice (once per changed
file). The extension then lets the watcher do the reload instead of asking for one, waits until
the reloads have settled (about 3 s), and only asks Decky itself if the watcher has done nothing
after 4 s (it is off for 10 s after the loader starts). Without the flag a deploy is a single
reload and finishes sooner.

**Auto-deploy on change** (off by default; toggle with **Plugin → Auto-deploy on change** or the
`decky-mcp.deploy.onChange` setting): changes to `dist/index.js`, `main.py` or
`py_modules/**/*.py` trigger a fast deploy 750 ms after the last change, without building. Keep
your bundler running in watch mode (`pnpm run watch`) so every save rebuilds `dist/index.js`. A
change during a running deploy queues one more deploy. Auto-deploys report in the status bar
instead of a notification.

## Remote input

The screen panel can drive the device with your keyboard, mouse and a gamepad. Remote input is **off
by default** and is a device-wide switch: it is the same flag as the **Allow remote input** toggle
in the device's Decky-MCP panel and the **⌨ Input** button in the browser viewer.

- **Turn it on or off** with the **Input** button in the screen panel toolbar (highlighted while
  on), or run **Decky: Toggle remote input** from the command palette. The extension sends
  `PUT /input/settings`; the panel itself never calls the device for this. While input is on the
  status bar shows `$(keyboard)` after the device's name. If the device cannot inject input, the button
  is disabled and its tooltip gives the reason. A Deck whose plugin predates remote input shows
  *not supported by this device version*.
- **Mouse and keyboard**: click the picture to capture input (a focus outline shows it). Mouse
  moves, clicks and the wheel land on the matching spot of the device screen, and keys are sent by
  physical position (`KeyboardEvent.code`), so VS Code keybindings do not fire while the picture
  has focus. Click the toolbar, switch tabs or leave the window to give the keyboard back; every
  held key and button is released.
- **Gamepad**: a controller connected to this computer is forwarded about 60 times a second while
  the panel has focus ("Gamepad connected" in the toolbar). It appears on the device as an Xbox 360
  pad. Whether the Gamepad API works inside a webview depends on the VS Code build.

The panel's WebSocket (`/input`) goes through the same loopback proxy as the stream, which adds the
token during the handshake.

## Stream settings and audio

The screen panel toolbar has the same controls as the browser viewer:

- **Stream** opens frame rate (15/24/30/60 fps), JPEG quality (50-90), size (native, 1600, 1280,
  960, 640 px wide) and **Audio** on/off. These are device-wide (`/stream/settings`, the same values
  the browser viewer and the `set_stream_settings` tool change). Like the input toggle, the panel
  asks the extension, which sends the `PUT`; the controls show *Applying…* until the first frame of
  the restarted stream arrives. Changes made elsewhere show up within one 5 s stats poll. A device
  without the route hides the button.
- **Sound** is on by default: the panel plays what the device is playing (`/audio`, raw 48 kHz
  stereo PCM, about 1.5 Mbit/s, through the same loopback proxy) with an AudioWorklet that keeps
  about 120 ms buffered and drops back when it falls 300 ms behind. **🔊 / 🔇** mutes this window
  only and the slider sets the local volume; both are kept with the panel's state. Until VS Code
  allows sound (it may need a click in the panel first) the toolbar says *Click anywhere to enable
  audio*. The audio socket closes while the panel is hidden, like the video stream.
- **Fullscreen** appears only where the webview allows the Fullscreen API.

## Pairing

Pairing starts when you connect to a device without a token (or whose token the device rejects), or
when you choose **Re-pair**.

1. **Reachability.** The extension calls `GET /health` (no token). If the device does not answer, you
   get one error: *Can't reach <name> at host:port. Is the device on and Decky-MCP enabled?* with
   **Retry** and **Edit device**. Nothing else happens.
2. **Request.** The extension files `POST /pair/request` with the name *VS Code on <hostname>*
   (*VSCodium* or *Cursor* in those editors) and gets a 4-digit code.
3. **Waiting, with no time limit.** One progress notification: *Decky-MCP: Waiting for approval on
   <name> · code 4821. On the device: Quick Access → Decky-MCP → Approve.* with **Cancel**; the device
   row says *waiting for approval · code 4821*. The device shows a toast *VS Code on <hostname> wants
   to pair · code 4821*, and its Decky-MCP panel switches to an *Approve pairing request?* prompt with
   **Approve** and **Deny**. The extension long-polls `GET /pair/request/{id}?wait=25`. Network errors (the device
   sleeping, a loader restart) only show *Lost contact with <name>, retrying…*; it keeps trying until
   you cancel. If the device forgot the request (plugin restarted), it files a new one and shows the
   new code. **Cancel** withdraws the request (`DELETE /pair/request/{id}`).
4. **Allowed.** The token is stored, the device becomes connected (the screen panel opens per
   `decky-mcp.openScreenOnConnect`) and you see *Paired with <name>* with **Open screen** and
   **Deploy plugin**.
5. **Denied.** *Pairing denied on <name>* with **Try again**.

A device whose plugin predates pairing requests gets *Update Decky-MCP on <name> to pair* with
**Enter token manually**; paste the token shown in its Decky-MCP panel. Other failures (for example
too many pending requests) offer **Try again** and **Enter token manually**.

### Adding a device

**Add device** asks for the IP address or hostname (`host:port` also works), then for an optional
name (press Enter to use the host). The port is 8765. A picker then offers **Connect to <name>**,
**Change port (8765)…** and **Not now**. Connect goes straight into the steps above.

## Connection model

- **One state object.** `Connection` holds the saved devices, the active device and its token, the
  session (the connected device) and a state per device: `unpaired`, `disconnected` (paired),
  `connecting`, `pairing`, `connected` or `unreachable`. The views, status bar, screen panel and
  preview subscribe to its events.
- **Health.** While connected, `/health` is checked every 15 s. If it fails, the device shows as
  unreachable but stays the connected device, with its token; when it answers again it is connected
  again. Commands such as Deploy need a connected device; if there is none they offer to connect.
- **Reconnect.** The connected device is remembered. After a window reload the extension reconnects to
  it silently if it answers and the token is still valid.

## Commands

All of these are also in the command palette under the `Decky:` category.

| Command | What it does |
| --- | --- |
| Decky: Connect | Connects to a device; pairs first when there is no valid token |
| Decky: Disconnect | Ends the session; keeps the token |
| Decky: Re-pair | Runs pairing again for a device |
| Decky: Enter token manually | Paste a token; it is checked with an MCP `tools/list` call |
| Decky: Disconnect and forget token | Forgets the token for the active device |
| Decky: Switch device / Add device… / Edit device / Remove device | Connect to another saved device, manage saved devices |
| Decky: Copy viewer URL | Copies `http://host:port/viewer` for a browser |
| Decky: Change host | Changes the active device's host/port and writes the `decky-mcp.host`/`port` settings |
| Decky: Open screen | Live screen panel with sound, fps / Mbps / resolution / audio kbps, stream settings, mute and volume, pause, fit/actual, snapshot and the remote input toggle |
| Decky: Open viewer in browser | Opens `http://host:port/viewer` in the default browser (pair the browser on the device) |
| Decky: Snapshot to file | Saves the current `/frame.jpg` with a Save dialog |
| Decky: Deploy plugin | Build if needed, zip, `POST /plugins/install`, reload just this plugin and confirm it (<kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>D</kbd>) |
| Decky: Deploy plugin (full restart) | Same, but restarts Decky Loader and waits for `/health` |
| Decky: Toggle auto-deploy on change | Flips `decky-mcp.deploy.onChange` for the workspace |
| Decky: Toggle remote input | Turns remote keyboard, mouse and gamepad input on or off for the whole device (`PUT /input/settings`) |
| Decky: Install plugin zip… | Uploads a plugin zip from disk to `/plugins/install?restart=loader` |
| Decky: Restart loader | `POST /loader/restart` (falls back to the `restart_loader` tool) |
| Decky: Reload plugin | `POST /plugins/{dir}/reload` for one plugin backend |
| Decky: Show loader logs | Streams `journalctl -u plugin_loader` via `/logs/stream` |
| Decky: Show plugin logs | Streams a plugin's log from `~/homebrew/logs/<dir>/` |
| Decky: Evaluate JS in Steam UI | Runs an expression with the `cef_evaluate` tool; result in an info message or the "Decky-MCP Console" output |
| Decky: Toast on device | Shows a Decky toast |
| Decky: Write MCP config for this workspace | Adds `mcpServers.decky` to `.mcp.json` in the first workspace folder |
| Decky: Copy MCP URL | Copies `http://host:port/mcp` |
| Decky: Copy token | Copies the bearer token (a secret) |
| Decky: Refresh / Refresh plugins | Re-reads the token and `/health`, checks which devices answer, reloads the plugin list |

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `decky-mcp.openScreenOnConnect` | `true` | Open the screen panel after the first successful connect of a session |
| `decky-mcp.host` | `10.0.70.18` | Device IP or hostname. Seeds the first saved device; used when the device list is empty |
| `decky-mcp.port` | `8765` | Decky-MCP server port (same rules as `host`) |
| `decky-mcp.pluginDirName` | (empty) | Target dir under `~/homebrew/plugins` for deploy; empty means the plugin folder's name |
| `decky-mcp.deploy.build` | `auto` | `auto`: build only when `src/` is newer than `dist/index.js`; `always`; `never` |
| `decky-mcp.deploy.onChange` | `false` | Fast-deploy (without building) when `dist/index.js`, `main.py` or `py_modules/**/*.py` change |

Saved devices live in VS Code's global state (`decky-mcp.devices`), so all windows share them.
Tokens are stored per `host:port` in secret storage.

## How it works

- **Token handling.** The token lives in `context.secrets`. Webviews never see it: the extension runs
  a loopback proxy (`127.0.0.1`, random port, random path prefix) that adds the
  `Authorization: Bearer` header and strips browser `Origin`/`Cookie` headers before forwarding to
  the device. WebSocket upgrades (`/input`, `/audio`) are forwarded the same way. The screen panel and the
  preview only know the proxy URL, and their CSP allows only that origin (plus its `ws:` form for
  the screen panel) and `blob:` (images, and the screen panel's inline AudioWorklet module, which
  Chromium checks against `script-src`). The one place the token leaves secret storage is `.mcp.json`, after a
  confirmation.
- **Theme.** The screen panel and preview use only VS Code theme colours (`--vscode-*` variables);
  only the video area itself is black.
- **Deploy** zips the staged files (see [Deploy](#deploy)) under a single `<dirname>/` folder with
  a built-in zip writer and uploads the zip. It confirms a fast reload from `/logs/tail` (the
  loader journal and the plugin's log) and `/plugins`. Build and deploy output goes to the
  "Decky" output channel.
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

Install the packaged build with `code --install-extension decky-mcp-0.5.0.vsix`.

### Smoke test (no device)

`scripts/smoke.mjs` loads the bundled extension against a stub `vscode` module and a fake device:

```sh
pnpm run smoke
```

It evaluates the `when` clauses in `package.json` against the context keys the extension sets, and
checks which views are visible before and after connecting, the device rows for an unpaired, a
paired and a connected device and the menus on them, the view title buttons, and the Actions tree
(exactly Screen, Plugin, Loader, Steam and MCP with their leaves, with and without a `plugin.json`
in the workspace). It detects plugins in a temporary workspace (with and without the `debug` flag,
depth limit, `node_modules` skipped), checks the build decisions, the staged file set and the exec
bit, the status bar button and the one-time prompt, and deploys against the fake device: first
install (loader restart), fast deploy (`restart=plugin`), debug-flagged deploy (watcher reloads),
full restart, a failing build and auto-deploy on change. It also checks that Connect on an unpaired device files a pairing request
(name, kind, the waiting message and the row's code, then approval), a denied request with Try
again, waiting through a lost connection and a forgotten request (new code) and Cancel sending
`DELETE`, the "Update Decky-MCP" path for an older device, the reachability error with Retry, the 15 s health check going unreachable and back, Add device, snapshot, Copy MCP URL /
token and Open viewer, and the remote input toggle (screen panel message, palette command, status
bar indicator, unavailable and unsupported devices), and the screen panel's stream settings and
audio: `ready` loads `/stream/settings`, `setStream` sends only known fields, a stats tick mirrors
outside changes, a 404 hides the button, and `media/screen.js` run in a minimal DOM toggles mute
and volume, posts `setStream` with the *Applying…* state and hides the audio controls when audio is
off device-wide.

### Deploy check (device)

`scripts/deploy-check.mjs` deploys a throwaway plugin built from the template through the same
code the extension uses and checks on the device that both halves changed:

```sh
DECKY_TOKEN_FILE=~/deck-token node scripts/deploy-check.mjs /path/to/decky-mcp-test [host] [port]
```

The plugin must be named `Decky-MCP Test`, export `VERSION` from `src/version.ts` and
`py_modules/testver/__init__.py`, set `window.__deckyMcpTestVersion = VERSION` in its frontend and
have a `version` method. The script rewrites those per round: first install, fast deploy with and
without the `debug` flag, a deploy with nothing to build and one full restart (skipped while a
`/stream.mjpeg` viewer is connected, unless `IGNORE_VIEWERS=1`). Each round checks the bundle's version via `cef_evaluate`,
the backend's via `loader/call_plugin_method`, `/plugins`, the number of `Loaded` lines and that
exactly one backend process runs. At the end Decky uninstalls the plugin (no loader restart).

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
(input must be off on the Deck; the check never turns it on), opens `/audio` through the proxy and
expects the format frame and at least 10 PCM chunks within 1 s (audio must be on; the check never
changes it), probes the newer routes, and validates a staged zip with `unzip -t`. The
stream checks need a screen that changes: gamescope sends no frames while the screen is static.
