# Decky Toolkit reference

Detailed reference for the plugin: tools, pairing, the screen panel, audio, remote input,
controllers, UI navigation, HTTP routes and internals. For setup see the [README](../README.md).

The plugin runs an HTTP server on the device (`http://<deck-ip>:8765`, protected by a token that
clients get by [pairing](#pairing)). The VS Code extension and your own scripts all talk to
it. The same server also speaks MCP Streamable HTTP on `/mcp`, so any MCP client can
use the tools below.

## MCP tools

| Tool | What it does |
| --- | --- |
| `decky_status` | Loader version, OS, Python runtime, uid, installed plugins |
| `list_plugins` | Plugins under `~/homebrew/plugins` with their `plugin.json` metadata |
| `read_plugin_log` | Tail a plugin's backend log from `~/homebrew/logs/<plugin>/` |
| `loader_log` | Tail `journalctl -u plugin_loader`, optional substring filter |
| `restart_loader` | Restart `plugin_loader.service` (scheduled 1 s out so the call returns); needs `confirm: true` |
| `install_plugin` | Install a plugin zip (device path or base64) atomically, then restart the loader (needs `confirm: true`), reload the plugin, or neither |
| `reload_plugin` | Reload one plugin's backend through Decky without restarting the loader |
| `plugin_methods` | List a plugin's frontend-callable backend methods (public async methods of `class Plugin`, with args and docstrings) |
| `call_plugin_method` | Call a plugin's backend method the way its frontend does; returns the result or Decky's Python traceback |
| `plugin_frontend_check` | Find `callable("x")`/`call("x")` names in a plugin's frontend that have no backend method |
| `cef_targets` | List Steam CEF DevTools tabs on `localhost:8080` |
| `cef_evaluate` | Run JS in a Steam tab (default `SharedJSContext`, where `window.DeckyPluginLoader` lives) |
| `cef_console` / `cef_console_clear` | Steam UI console output (console calls, uncaught exceptions, browser log), captured in the background per tab |
| `cef_screenshot` | PNG screenshot of a Steam tab via `Page.captureScreenshot` |
| `screen_capture` | JPEG of the full gamescope display (games included) from its PipeWire video node |
| `stream_status` | Live stream state: running, fps, bitrate, resolution, viewer count, settings |
| `set_stream_settings` | Change the stream's frame rate (1-60), JPEG quality and output width |
| `toast` | Show a Decky toast in the Steam UI |
| `set_input_enabled` | Turn remote input on or off (off by default) |
| `input_key` / `input_text` | Press key combos (`"ctrl+shift+a"`, `"enter"`) or type ASCII text |
| `input_mouse` | Move, click, double-click, hold or scroll the pointer (normalised or pixel coordinates) |
| `input_gamepad` | Press buttons, move sticks and triggers on a virtual Xbox 360 pad (`pad` picks one), or run a sequence |
| `list_controllers` | Gamepads as Steam Input sees them (type, slot, active), merged with evdev detail |
| `add_virtual_controller` / `remove_virtual_controller` | Plug in or unplug a virtual Xbox 360 pad; returns once Steam Input lists it |
| `ui_routes` | Steam and Decky pages you can navigate to, plugin routes, current page and menu state |
| `ui_navigate` | Go to a page (`/settings/display`, `/decky/settings`), back, open Quick Access / a Decky plugin panel / a game page |
| `ui_query` | Find elements by CSS selector or text, with screen coordinates ready for `input_mouse` |
| `ui_focus` | The element that has gamepad focus, plus the current route |
| `ui_wait_for` | Wait until an element appears or disappears, or a route is shown, instead of sleeping |
| `read_file` / `write_file` | Read or write files on the device (runs as root); Steam credential/session files and SSH keys are refused |
| `apps_list` / `app_info` | Steam library from the client: install dir, Proton or runtime, size, last played; one app with its dirs |
| `apps_running` | Running apps with the pid of their `reaper` process and its children |
| `app_launch` / `app_terminate` | Start a game like pressing Play; force-quit it (`confirm: true`) |
| `game_dirs` | Install dir, Proton prefix and its AppData/Documents dirs, Steam Cloud userdata, shader cache, XDG dirs |
| `game_saves` | Likely save files: Steam Cloud's own list first, then Auto-Cloud dirs, then heuristics |
| `proton_log` | `~/steam-<appid>.log` (PROTON_LOG) and the app's lines in Steam's `logs/` |
| `fs_list` / `fs_stat` / `fs_delete` | Browse the device; delete only inside game, prefix, userdata or plugin data dirs (`confirm: true`) |
| `screen_record` / `screen_record_stop` | Record up to 120 s of screen and sound to an MKV (MJPEG + PCM) from the live stream |
| `recordings_list` / `recording_delete` | Saved recordings (download via `GET /recordings/<name>`); delete with `confirm: true` |
| `perf_overlay` / `perf_overlay_status` | Steam's performance overlay level 0-4, as on the Quick Access performance tab |

## Pairing

A client never needs the token typed in. It asks the device for access, and you allow it on the
device itself. There is no time limit: a request waits as long as the client is waiting.

From the VS Code extension (see [extension/README.md](../extension/README.md#pairing)):

1. Add the device and click it in the Decky **Devices** view.
2. The editor shows *Waiting for approval on <device> · code 4821* (and the device row says
   *waiting for approval · code 4821*).
3. On the device a toast says *VS Code on <your-pc> wants to pair · code 4821*. Open Quick Access
   (…) → Decky Toolkit. While a request is pending the panel shows only *Approve pairing request?* with
   *VS Code on <your-pc> (<your-ip>) · code 4821* and **Approve** / **Deny** side by side (several
   requests come one at a time, "1 of 3"). Check the code and press **Approve**.
4. The extension stores the token and connects. Deny shows *Pairing denied on <device>* with
   **Try again**; Cancel in the editor withdraws the request.

Other clients (scripts, CLI agents) use the same routes:
`POST /pair/request`, then long-poll `GET /pair/request/{id}?wait=25` until it returns the token;
see [docs/api.md](api.md#pairing). Pending requests expire 60 s after their client stops
polling, at most 10 can be pending (2 per address), and the toast and code let you spot a request
you did not make.

The normal panel is deliberately minimal: the device's IP address in large type ("port 8765"
below it), which is all the extension's Add device needs, and one server status line. Everything
else (server and remote input toggles, restart, regenerate token, the token itself) is under
**Advanced**.

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
stream routes are behind the same token: `/stream.mjpeg` (multipart MJPEG), `/frame.jpg` (one
current frame), `/stream/stats` (JSON), `/stream/settings` (`GET`/`PUT` JSON) and `/audio` (PCM
over WebSocket). The extension reaches them through a loopback proxy that adds the token, so the
webview never holds it.

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
from the screen panel, `PUT /stream/settings` or the `set_stream_settings` tool. Measured on the BC-250
at 1080p, JPEG quality 70, with a changing screen: 60 fps costs about 33-40 % of one CPU core and
30-100 Mbit/s depending on content; 30 fps about 23 % and up to ~50 Mbit/s. On Wi-Fi, lower the
width or quality.

## Audio

The stream has sound. It is **on by default**: the screen panel plays what the Deck is playing,
taken from the default audio output's monitor. Audio goes as raw 16-bit 48 kHz stereo PCM over a
WebSocket (`/audio`), about 1.5 Mbit/s, which is small next to the video. The capture costs well
under 1 % of one CPU core (`gst-launch-1.0 pipewiresrc ! audioconvert`) and only runs while someone
listens.

- The mute icon and **Volume** in the stream settings act on this computer only; the Deck keeps
  playing and other clients are not affected. Both are remembered.
- Webviews start sound only after a user action, so the panel shows *Click the picture to enable
  audio* until you click or press a key in it.
- **Audio** in the stream settings turns the audio stream on or off for every client (device-wide,
  stored as `audio_enabled` in `settings.json`; also `PUT /stream/settings` with `{"audio": false}`
  or the `set_stream_settings` tool). Turning it off closes every audio socket.
- Playback runs in an AudioWorklet that keeps about 120 ms of sound buffered and drops back to that
  when it falls more than 300 ms behind, so sound and picture stay together.

## Remote input

The screen panel and MCP clients can drive the Deck with keyboard, mouse and gamepad input. It is
**off by default**. Turn it on with the **Allow remote input** toggle in the Decky Toolkit panel, the
keyboard icon in the screen panel's tab bar, `PUT /input/settings` or the `set_input_enabled` tool. The setting
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

- Input is full control of the device: store purchases, Desktop Mode, a terminal. It needs the
  bearer token and passes the same `Origin` check as the other routes.
- Input is off until you turn it on.
- The Deck shows a toast "Remote input from <ip>" when a client starts sending input, and every
  input session is written to the plugin log.
- Keys, mouse buttons and the gamepad are released when a client disconnects, when input is turned
  off and when the plugin unloads.

## Controllers

`list_controllers` (or `GET /controllers`) shows what Steam Input has: each controller's Steam type,
player slot and whether it is the active one, plus the kernel device it maps to.
`add_virtual_controller` plugs in a virtual Xbox 360 pad (up to 4) and only returns once Steam
Input lists it; drive it with `input_gamepad(pad=<id>)`, which goes through Steam Input like a real
controller, and unplug it with `remove_virtual_controller`. Without `pad`, `input_gamepad` uses an
implicit pad that disappears after 60 s idle. `GET /controllers/events` streams every change.

## UI navigation

`ui_navigate` moves the Steam UI with Decky's own navigation helpers: `path` for a page
(`/library/home`, `/settings/audio`, `/settings/controller`, `/decky/settings/plugins`, routes Decky
plugins registered), or `action` `back`, `quick_access` (with `tab`, e.g. `decky`), `main_menu`,
`close_menus`, `plugin` (opens that Decky plugin's Quick Access panel) or `app` (a game page).
`ui_routes` lists the verified pages. Both have HTTP twins (`GET /ui/routes`, `POST /ui/navigate`).

## REST endpoints

Besides `/mcp` the server has plain HTTP routes for scripts and editor integrations; see
[docs/api.md](api.md) for the full list. The most useful ones:

```sh
curl -H "Authorization: Bearer $TOKEN" -F file=@my-plugin.zip "http://<deck-ip>:8765/plugins/install?restart=loader"
curl -N -H "Authorization: Bearer $TOKEN" "http://<deck-ip>:8765/logs/stream?plugin=my-plugin"   # SSE
curl -H "Authorization: Bearer $TOKEN" "http://<deck-ip>:8765/logs/tail?source=loader&tail=50"
curl -H "Authorization: Bearer $TOKEN" "http://<deck-ip>:8765/apps/70300/saves"
curl -OJ -H "Authorization: Bearer $TOKEN" "http://<deck-ip>:8765/recordings/<name>"
curl -X POST -H "Content-Type: application/json" -d '{"client_name":"my script","client_kind":"other"}' \
  "http://<deck-ip>:8765/pair/request"                   # {id, code}; allow it on the device, then:
curl "http://<deck-ip>:8765/pair/request/<id>?wait=25"   # {status: "approved", token, ...} once
```

## How it works

- `main.py` is the Decky backend. It loads settings, then starts an `aiohttp` server from inside the
  plugin's asyncio loop. `aiohttp` comes from the loader's own PyInstaller bundle, so there are no
  dependencies to vendor.
- `py_modules/decky_toolkit/protocol.py` implements the JSON-RPC methods `initialize`, `ping`,
  `tools/list`, `tools/call` and the HTTP transport rules (bearer auth, `Origin` check, 202 for
  notifications, 405 for GET).
- `py_modules/decky_toolkit/cdp.py` is a tiny Chrome DevTools Protocol client used to talk to Steam's
  CEF debugger. The plugin deliberately does **not** connect to the loader's own websocket on port
  1337: the loader keeps a single client and would kick the Steam UI off.
- `src/index.tsx` is the Quick Access panel. It only mirrors state: the endpoint, pairing requests to
  approve or deny, the stream and input status, a server restart and token regeneration.

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

Connect Claude Code:

```sh
claude mcp add --transport http decky http://<deck-ip>:8765/mcp -H "Authorization: Bearer <token>"
```

The token lives in `~/homebrew/settings/decky-toolkit/settings.json` on the device (mode 0600, owned by
root) and is shown in the plugin panel.

## Security notes

- The server binds `0.0.0.0` by default. Bazzite's default firewalld zone already allows TCP
  1025-65535 inbound, so it is reachable from the LAN as soon as the plugin loads.
- Traffic is plain HTTP, so the token is visible on the local network. Treat this as a development
  tool on a trusted LAN. Disable it from the panel when not in use.
- `write_file`, `read_file` and `cef_evaluate` are intentionally powerful: anyone with the token
  has root on the device.
- The file browser tools (`fs_*`, `game_saves`) refuse Steam's login files (`config/loginusers.vdf`,
  `config/config.vdf`, `ssfn*`). Destructive tools (`fs_delete`, `app_terminate`, `recording_delete`) need
  `confirm: true`, and `fs_delete` only works inside game, Proton prefix, userdata and plugin data dirs.

## Targets

- Tested: Bazzite `bazzite-deck-44.20261012` (Fedora 44) on an AMD BC-250 board, Decky Loader
  v3.3.1 (bundled CPython 3.14.8), SELinux enforcing, firewalld active.
- Vetted from Valve's 3.8.14 recovery image, not yet run on hardware: stock SteamOS 3.8 ships
  gstreamer 1.26 with `gst-plugin-pipewire`, `gst-plugins-good`, `gst-plugins-base`, ffmpeg 7.1
  with `h264_vaapi`, and gamescope with the PipeWire node always on in Game Mode. No SELinux and
  `/home` is mounted exec, so the same plugin zip should work unchanged.
