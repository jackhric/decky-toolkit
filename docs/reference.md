# Decky Toolkit reference

Detailed reference for the plugin: tools, pairing, the screen panel, audio, remote input,
controllers, UI navigation, HTTP routes and internals. For setup see the [README](../README.md).

The plugin runs an HTTPS server on the device (`https://<deck-ip>:8765`, open only to clients you
have [paired](#pairing)). The VS Code extension talks to it, and relays MCP to your coding agent on a
loopback URL (`Decky: Copy MCP URL`), so any MCP client can use the tools below.

## MCP tools

Tools are named `<area>_<action>`. Each table row is one area.

| Area | Tools |
| --- | --- |
| `device_` | `device_info` (Decky version, OS, Python, kernel, desktop user), `device_activity` (someone at the device: last physical input from any non-virtual input device, times only; last remote input and client; app in front; screen viewers), `device_run` (shell command as the desktop user with its `XDG_RUNTIME_DIR`, D-Bus and `DISPLAY=:0`, or as root with `root: true`; timeout, output cap, every command logged) |
| `logs_` | `logs_read` (`source`: `loader` journal with `since`/`until`, a `plugin`'s log with `run` 1 = previous backend run, `steam_console` captured in the background with `target`/`level`/`since`, `proton` for an `appid`; all take `lines`, `grep`, `match`), `logs_wait` (block until a `loader`, `plugin` or `steam_console` line matches a regex; `since_s` also accepts recent lines) |
| `plugin_` | `plugin_list`, `plugin_install` (zip from a device path or base64; restart the loader with `confirm: true`, reload the plugin, or neither), `plugin_reload` (`mode` `backend` (default, waits) or `frontend` (~10 ms); restores the plugin's panel, route, tab and focus), `plugin_methods` (frontend-callable backend methods), `plugin_call` (call one as the frontend does; result or Decky's Python traceback), `plugin_frontend_check` (`callable("x")` names with no backend method). All take `plugin`: the directory or the `plugin.json` name. |
| `loader_` | `loader_restart` (scheduled 1 s out so the call returns; `confirm: true`) |
| `toolkit_` | `toolkit_stacks` (Decky Toolkit's own threads and asyncio tasks, event loop lag and stalls) |
| `ui_` | `ui_state` (route, menu, Quick Access tab, Decky panel, running game, focused element, open dialog, on-screen keyboard, someone at the device; input tools return it after every input), `ui_routes`, `ui_navigate` (a page, back, Quick Access, a Decky plugin panel, a game page), `ui_query` (elements by CSS selector or text, with coordinates for `input_mouse`), `ui_focus`, `ui_wait` (an element, its absence or a route, instead of sleeping), `ui_toast` |
| `cef_` | `cef_targets`, `cef_evaluate` (JS in a Steam tab, default `SharedJSContext`), `cef_screenshot` (PNG of one tab) |
| `screen_` | `screen_capture` (JPEG of the whole gamescope display, games included), `screen_record` / `screen_record_stop` (up to 120 s of screen and sound to MKV) |
| `recording_` | `recording_list`, `recording_delete` (`confirm: true`); a client fetches the file with `GET /api/v1/fs/read` |
| `stream_` | `stream_status` (running, fps, bitrate, resolution, viewers, audio), `stream_settings` (no arguments: read; `fps`, `quality`, `width`, `audio`: change) |
| `input_` | `input_settings` (no arguments: read; `enabled`: turn remote input on or off, off by default), `input_key`, `input_text`, `input_mouse`, `input_gamepad` |
| `controller_` | `controller_list` (gamepads as Steam Input sees them, with evdev detail), `controller_add` / `controller_remove` (a virtual Xbox 360 pad; returns once Steam Input lists it) |
| `app_` | `app_list` (Steam library; `running: true` lists running apps with the pid of their `reaper` process), `app_info`, `app_launch`, `app_terminate` (`confirm: true`), `app_dirs` (install dir, Proton prefix and its user dirs, Steam Cloud userdata, shader cache, XDG dirs), `app_saves` (likely save files, Steam Cloud's own list first) |
| `fs_` | `fs_list`, `fs_stat`, `fs_read`, `fs_write` (as root; Steam credential/session files and SSH keys refused), `fs_delete` (only inside game, prefix, userdata or plugin data dirs; `confirm: true`) |
| `perf_` | `perf_overlay` (no `level`: read; `level` 0-4 as on the Quick Access performance tab: set) |

Other plugins can add their own tools from their frontend with `registerTool` from `decky-toolkit/tools`; they are
listed as `<plugin directory>_<name>` (see [api.md](api.md#plugin-tools) and the site's "Give agents your plugin's own
tools" page). `plugin_list` shows each plugin's tools under `mcp_tools`, and the refused ones with the reason.

The CLI's `decky-toolkit mcp` adds `plugin_deploy` (package and install a plugin folder from the machine it runs on) and
`device_status` (which device this machine is paired with and whether it answers).

## Pairing

A client never needs a secret typed in. It asks the device for access, and you allow it on the
device itself. There is no time limit: a request waits as long as the client is waiting.

From the VS Code extension (see [extension/README.md](../extension/README.md#pairing)):

1. Add the device and click it in the Decky **Devices** view.
2. The editor shows *Waiting for approval on <device> · code 4821* (and the device row says
   *waiting for approval · code 4821*).
3. On the device a toast says *VS Code on <your-pc> wants to pair · code 4821*. Open Quick Access
   (…) → Decky Toolkit. While a request is pending the panel shows only a large
   **Approve VS Code on <your-pc>** button with *Code 4821 · <your-ip>* under it and **Deny** below
   (several requests come one at a time, "Request 1 of 3"). Check the code and press **Approve**.
4. The extension stores its pairing and connects. Deny shows *Pairing denied on <device>* with
   **Try again**; Cancel in the editor withdraws the request.

Other clients (scripts, CLI agents) use the same routes:
`POST /api/v1/pair/request`, then long-poll `GET /api/v1/pair/request/{id}?wait=25` until it returns the credentials;
see [docs/api.md](api.md#pairing). Pending requests expire 60 s after their client stops
polling, at most 10 can be pending (2 per address), and the toast and code let you spot a request
you did not make.

The normal panel is deliberately minimal: the Decky Toolkit mark, the device's IP address in large
type ("port 8765" below it), which is all the extension's Add device needs, one line of help (or why
the server is not running) and a **How pairing works** link. The gear button in the panel header opens
the plugin's settings page, a Steam-style page with categories on the left: **Server** (enable toggle, status, address, port, restart), **Remote
input** and **Paired devices**, which lists every paired client with its last use and a **Forget**
button, which only works on the device.

## Screen panel

The live screen is only in the VS Code extension: **Open screen** in the Actions view (or the
Preview view) opens it beside your editor. There is no browser viewer. The panel shows the full
display at 30 fps (1080p, roughly 50 Mbit/s at the default JPEG quality 70) and nothing else; its
controls are icons in the editor tab bar:

| Icon | Action |
| --- | --- |
| `$(keyboard)` / `$(record-keys)` | Turn remote input on / off (device-wide, see [Remote input](#remote-input)) |
| `$(unmute)` / `$(mute)` | Mute / unmute sound on this computer; shown while the device streams audio |
| `$(settings-gear)` | Stream settings: frame rate (15/24/30/60 fps), JPEG quality, size (native, 1600, 1280, 960, 640 px wide) and audio for every client; volume and the gamepad target for this computer |
| `$(debug-pause)` / `$(play)` | Pause / resume the picture |
| `$(device-camera)` | Save the current frame as a JPEG |

A settings change applies within a fraction of a second without dropping the connection. The
stream routes are open only to paired clients: `/api/v1/stream` (multipart MJPEG), `/api/v1/stream/frame` (one
current JPEG), `/api/v1/stream/stats` (JSON), `/api/v1/stream/settings` (`GET`/`PUT` JSON) and `/api/v1/audio` (PCM
over WebSocket). The extension reaches them through a loopback proxy that holds the pairing, so the
webview never does.

Stream settings are device-wide; the last change wins. There is one capture pipeline, and every
editor panel, recording and MCP tool call shares it, so changing the frame rate in one window
changes it for everybody.

Capture comes from gamescope's own PipeWire `Video/Source` node, read by a `gst-launch-1.0`
subprocess (`pipewiresrc ! videoconvert ! videorate ! jpegenc ! multipartmux`). Every element is
part of the stock Bazzite and SteamOS 3.8 images, so there is nothing to install. The pipeline only
runs while a panel, recording or tool call is consuming frames and stops 10 s after the last one leaves.

gamescope only pushes a frame when it repaints, so the plugin nudges it with
`gamescopectl debug_force_repaint` when a stream starts, and `pipewiresrc keepalive-time=100`
re-emits the last frame so static screens still stream. Frame rate, JPEG quality and output width
are stored in `settings.json` (`stream_fps`, `stream_quality`, `stream_width`) and can be changed
from the screen panel, `PUT /api/v1/stream/settings` or the `stream_settings` tool. Measured on the BC-250
at 1080p, JPEG quality 70, with a changing screen: 60 fps costs about 33-40 % of one CPU core and
30-100 Mbit/s depending on content; 30 fps about 23 % and up to ~50 Mbit/s. On Wi-Fi, lower the
width or quality.

## Audio

The stream has sound. It is **on by default**: the screen panel plays what the Deck is playing,
taken from the default audio output's monitor. Audio goes as raw 16-bit 48 kHz stereo PCM over a
WebSocket (`/api/v1/audio`), about 1.5 Mbit/s, which is small next to the video. The capture costs well
under 1 % of one CPU core (`gst-launch-1.0 pipewiresrc ! audioconvert`) and only runs while someone
listens.

- The mute icon and **Volume** in the stream settings act on this computer only; the Deck keeps
  playing and other clients are not affected. Both are remembered.
- Webviews start sound only after a user action, so the panel shows *Click the picture to enable
  audio* until you click or press a key in it.
- **Audio** in the stream settings turns the audio stream on or off for every client (device-wide,
  stored as `audio_enabled` in `settings.json`; also `PUT /api/v1/stream/settings` with `{"audio": false}`
  or the `stream_settings` tool). Turning it off closes every audio socket.
- Playback runs in an AudioWorklet that keeps about 120 ms of sound buffered and drops back to that
  when it falls more than 300 ms behind, so sound and picture stay together.

## Remote input

The screen panel and MCP clients can drive the Deck with keyboard, mouse and gamepad input. It is
**off by default**. Turn it on with the **Allow remote input** toggle on the Decky Toolkit settings page (gear in the panel header), the
keyboard icon in the screen panel's tab bar, `PUT /api/v1/input/settings` or the `input_settings` tool. The setting
is stored in `settings.json` and applies to every client.

In the screen panel, with input on:

- **Mouse and keyboard**: click the picture to capture the keyboard (a blue outline shows it).
  Mouse moves, clicks and the wheel land on the matching spot of the Deck screen, and keys are sent
  by physical position (`KeyboardEvent.code`). Clicking outside the picture, switching tabs or
  leaving the window releases every held key.
- **Gamepad**: a controller plugged into your computer is forwarded about 60 times a second while
  the panel has focus (the panel briefly shows *Gamepad connected*). By default it drives a pad the
  Deck creates on its own (an Xbox 360 pad, removed 60 s after the last input); **Gamepad goes to**
  in the stream settings sends it to one of your virtual pads instead, or creates one.

Keyboard and mouse go through gamescope's own libei input server, so a pointer position lands 1:1
on the Steam UI (verified to the pixel) and a key press works like a real keyboard. If gamescope
has no libei socket, the plugin falls back to uinput devices. The gamepad is always a uinput
device that Steam opens like a real controller. All of it is stdlib plus `ctypes`; nothing to
install.

Security notes for input:

- Input is full control of the device: store purchases, Desktop Mode, a terminal. It needs a
  paired client and passes the same `Origin` check as the other routes.
- Input is off until you turn it on.
- The Deck shows a toast "Remote input from <ip>" when a client starts sending input, and every
  input session is written to the plugin log.
- Keys, mouse buttons and the gamepad are released when a client disconnects, when input is turned
  off and when the plugin unloads.

## Controllers

`controller_list` (or `GET /api/v1/controllers`) shows what Steam Input has: each controller's Steam type,
player slot and whether it is the active one, plus the kernel device it maps to.
`controller_add` plugs in a virtual Xbox 360 pad (up to 4) and only returns once Steam
Input lists it; drive it with `input_gamepad(pad=<id>)`, which goes through Steam Input like a real
controller, and unplug it with `controller_remove`. Without `pad`, `input_gamepad` uses an
implicit pad that disappears after 60 s idle. `GET /api/v1/controllers/events` streams every change.

## UI navigation

`ui_navigate` moves the Steam UI with Decky's own navigation helpers: `path` for a page
(`/library/home`, `/settings/audio`, `/settings/controller`, `/decky/settings/plugins`, routes Decky
plugins registered), or `action` `back`, `quick_access` (with `tab`, e.g. `decky`), `main_menu`,
`close_menus`, `plugin` (opens that Decky plugin's Quick Access panel) or `app` (a game page).
`ui_routes` lists the verified pages. Clients use `GET /api/v1/ui/routes` and `POST /api/v1/ui/navigate`.

## Client API

Agents use the MCP tools on `/mcp`; the extension, the CLI and your scripts use the versioned client API under
`/api/v1` instead, a stable contract that the tools (which keep changing) are not. Both call the same functions on the
device. See [docs/api.md](api.md) for the full list. The most useful routes:

```sh
# C="--cert client.crt --key client.key --cacert server.crt"   (the files of a paired identity)
curl $C -F file=@my-plugin.zip "https://<deck-ip>:8765/api/v1/plugins/install?restart=loader"
curl $C -N "https://<deck-ip>:8765/api/v1/logs/stream?plugin=my-plugin"   # SSE
curl $C "https://<deck-ip>:8765/api/v1/logs/tail?source=loader&tail=50"
curl $C "https://<deck-ip>:8765/api/v1/apps/70300/saves"
curl $C -o shot.jpg "https://<deck-ip>:8765/api/v1/stream/frame"
```

Pairing a script yourself (key generation, `POST /api/v1/pair/request`, the credentials in the approval) is
described in [docs/api.md](api.md#pairing).

## How it works

- `main.py` is the Decky backend. It loads settings, then starts an `aiohttp` server from inside the
  plugin's asyncio loop. `aiohttp` comes from the loader's own PyInstaller bundle, so there are no
  dependencies to vendor.
- `py_modules/decky_toolkit/server/protocol.py` implements the JSON-RPC methods `initialize`, `ping`,
  `tools/list`, `tools/call` and the HTTP transport rules (client-certificate auth, `Origin` check, 202 for
  notifications, 405 for GET).
- `py_modules/decky_toolkit/steam/cdp.py` is a tiny Chrome DevTools Protocol client used to talk to Steam's
  CEF debugger. The plugin deliberately does **not** connect to the loader's own websocket on port
  1337: the loader keeps a single client and would kick the Steam UI off.
- `src/index.tsx` is the Quick Access panel (the address, or the pending pairing request to approve or
  deny) and the settings page at `/decky-toolkit/settings` (a `SidebarNavigation` with Server, Remote input and Paired devices). Both
  only mirror state.

The plugin runs with the `root` flag so it can restart the loader, read every plugin's logs and write
anywhere. The `debug` flag makes the loader hot-reload the plugin when its files change, which is how
a fast deploy of a debug-flagged plugin takes effect without an explicit reload.

## Development

Requirements on the dev machine: Node 18+, pnpm 9+, and for the Python tests
[uv](https://docs.astral.sh/uv/). This repo is itself a plugin, so the extension deploys it like any
other: open the repo in VS Code, pair with a device that has a released Decky Toolkit installed, and
press Deploy. A fresh device gets the release from the install URL in the README first.

```sh
pnpm install
pnpm run build       # or pnpm run watch, with deploy-on-change in the extension
./scripts/test.sh    # Python unit tests
```

Connect Claude Code through the extension's loopback relay: **Decky: Copy MCP URL** (or **Write MCP
config for this workspace**) gives `http://127.0.0.1:8766/<secret>/mcp`, and

```sh
claude mcp add --transport http decky <that url>
```

needs no header. The port is `decky-toolkit.mcpPort` (default 8766; the next free one when taken), and the URL
stays the same across restarts.

## Security notes

- The server binds `0.0.0.0` by default. Bazzite's default firewalld zone already allows TCP
  1025-65535 inbound, so it is reachable from the LAN as soon as the plugin loads.
- Only paired clients are served. Treat this as a development tool on a trusted LAN and disable it
  on the plugin settings page when not in use.
- `fs_write`, `fs_read` and `cef_evaluate` are intentionally powerful: any paired client
  has root on the device.
- The file browser tools (`fs_*`, `app_saves`) refuse Steam's login files (`config/loginusers.vdf`,
  `config/config.vdf`, `ssfn*`). Destructive tools (`fs_delete`, `app_terminate`, `recording_delete`) need
  `confirm: true`, and `fs_delete` only works inside game, Proton prefix, userdata and plugin data dirs.

## Targets

- Tested: Bazzite `bazzite-deck-44.20261012` (Fedora 44) on an AMD BC-250 board, Decky Loader
  v3.3.1 (bundled CPython 3.14.8), SELinux enforcing, firewalld active.
- Vetted from Valve's 3.8.14 recovery image, not yet run on hardware: stock SteamOS 3.8 ships
  gstreamer 1.26 with `gst-plugin-pipewire`, `gst-plugins-good`, `gst-plugins-base`, ffmpeg 7.1
  with `h264_vaapi`, and gamescope with the PipeWire node always on in Game Mode. No SELinux and
  `/home` is mounted exec, so the same plugin zip should work unchanged.
