# Decky-MCP

A [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader) plugin that runs a
[Model Context Protocol](https://modelcontextprotocol.io) server on the Steam Deck itself, so AI
coding agents on your dev machine (Claude Code, Cursor, MCP Inspector, …) can inspect and drive the
device while you develop other Decky plugins.

The server speaks MCP Streamable HTTP (stateless, plain JSON responses) on `http://<deck-ip>:8765/mcp`,
protected by a bearer token shown in the plugin's Quick Access panel.

## Tools

| Tool | What it does |
| --- | --- |
| `decky_status` | Loader version, OS, Python runtime, uid, installed plugins |
| `list_plugins` | Plugins under `~/homebrew/plugins` with their `plugin.json` metadata |
| `read_plugin_log` | Tail a plugin's backend log from `~/homebrew/logs/<plugin>/` |
| `loader_log` | Tail `journalctl -u plugin_loader`, optional substring filter |
| `restart_loader` | Restart `plugin_loader.service` (scheduled 1 s out so the call returns) |
| `install_plugin` | Install a plugin zip (device path or base64) atomically, then restart the loader, reload the plugin, or neither |
| `reload_plugin` | Reload one plugin's backend through Decky without restarting the loader |
| `cef_targets` | List Steam CEF DevTools tabs on `localhost:8080` |
| `cef_evaluate` | Run JS in a Steam tab (default `SharedJSContext`, where `window.DeckyPluginLoader` lives) |
| `cef_screenshot` | PNG screenshot of a Steam tab via `Page.captureScreenshot` |
| `screen_capture` | JPEG of the full gamescope display (games included) from its PipeWire video node |
| `stream_status` | Live stream state: running, fps, bitrate, resolution, viewer count |
| `toast` | Show a Decky toast in the Steam UI |
| `read_file` / `write_file` | Read or write files on the device (runs as root) |

## Live screen viewer

Easiest way in: press **Pair a browser (120 s)** in the Decky-MCP panel, then open
`http://<deck-ip>:8765/viewer` on any device on your network within two minutes. The server hands
that browser an HttpOnly cookie, the panel counts paired devices and shows a toast with each one's
IP, and the window closes after 120 s or when you press **Stop pairing**. Alternatively open
`/viewer?token=<token>` once; the token moves into the same cookie. Either way the page shows the full display at 30 fps (1080p, roughly 50 Mbit/s at the default JPEG
quality 70) with fps, bitrate and resolution readouts, pause, fit/actual size, snapshot and
fullscreen. Other endpoints, all behind the same token: `/stream.mjpeg` (multipart MJPEG),
`/frame.jpg` (one current frame) and `/stream/stats` (JSON).

Capture comes from gamescope's own PipeWire `Video/Source` node, read by a `gst-launch-1.0`
subprocess (`pipewiresrc ! videoconvert ! videorate ! jpegenc ! multipartmux`). Every element is
part of the stock Bazzite and SteamOS 3.8 images, so there is nothing to install. The pipeline only
runs while a viewer or tool call is consuming frames and stops 10 s after the last one leaves.

gamescope only pushes a frame when it repaints, so the plugin nudges it with
`gamescopectl debug_force_repaint` when a stream starts, and `pipewiresrc keepalive-time=100`
re-emits the last frame so static screens still stream. Frame rate, JPEG quality and output width
are settings (`stream_fps`, `stream_quality`, `stream_width`); lower the width or quality on Wi-Fi.

## REST endpoints

Besides `/mcp` the server has plain HTTP routes for scripts and editor integrations; see
[docs/api.md](docs/api.md) for the full list. The most useful ones:

```sh
curl -H "Authorization: Bearer $TOKEN" -F file=@my-plugin.zip "http://<deck-ip>:8765/plugins/install?restart=loader"
curl -N -H "Authorization: Bearer $TOKEN" "http://<deck-ip>:8765/logs/stream?plugin=my-plugin"   # SSE
curl -H "Authorization: Bearer $TOKEN" "http://<deck-ip>:8765/logs/tail?source=loader&tail=50"
curl "http://<deck-ip>:8765/pair"   # token JSON, only during the panel's 120 s pairing window
```

## How it works

- `main.py` is the Decky backend. It loads settings, then starts an `aiohttp` server from inside the
  plugin's asyncio loop. `aiohttp` comes from the loader's own PyInstaller bundle, so there are no
  dependencies to vendor.
- `py_modules/decky_mcp/protocol.py` implements the JSON-RPC methods `initialize`, `ping`,
  `tools/list`, `tools/call` and the HTTP transport rules (bearer auth, `Origin` check, 202 for
  notifications, 405 for GET).
- `py_modules/decky_mcp/cdp.py` is a tiny Chrome DevTools Protocol client used to talk to Steam's
  CEF debugger. The plugin deliberately does **not** connect to the loader's own websocket on port
  1337: the loader keeps a single client and would kick the Steam UI off.
- `src/index.tsx` is the Quick Access panel: enable/disable, endpoint, token, restart, regenerate token.

The plugin runs with the `root` flag so it can restart the loader, read every plugin's logs and write
anywhere. The `debug` flag makes the loader hot-reload the plugin when `dist/index.js` or `main.py`
change (changes under `py_modules/` still need a loader restart).

## Development

Requirements on the dev machine: Node 18+, pnpm 9, rsync, ssh key access to the device with
passwordless sudo.

```sh
pnpm install
cp deploy.env.example deploy.env   # set DECK_HOST / DECK_USER
pnpm run deploy                    # build, rsync, install, restart plugin_loader
./scripts/smoke.sh                 # health, initialize, tools/list, two tool calls
./scripts/logs.sh                  # follow the loader journal (add -a for everything)
```

Connect Claude Code:

```sh
claude mcp add --transport http decky http://<deck-ip>:8765/mcp -H "Authorization: Bearer <token>"
```

The token lives in `~/homebrew/settings/decky-mcp/settings.json` on the device (mode 0600, owned by
root) and is shown in the plugin panel.

## Security notes

- The server binds `0.0.0.0` by default. Bazzite's default firewalld zone already allows TCP
  1025-65535 inbound, so it is reachable from the LAN as soon as the plugin loads.
- Traffic is plain HTTP, so the token is visible on the local network. Treat this as a development
  tool on a trusted LAN. Disable it from the panel when not in use.
- `write_file`, `read_file` and `cef_evaluate` are intentionally powerful: anyone with the token
  has root on the device.

## Targets

- Tested: Bazzite `bazzite-deck-44.20261012` (Fedora 44) on an AMD BC-250 board, Decky Loader
  v3.3.1 (bundled CPython 3.14.8), SELinux enforcing, firewalld active.
- Vetted from Valve's 3.8.14 recovery image, not yet run on hardware: stock SteamOS 3.8 ships
  gstreamer 1.26 with `gst-plugin-pipewire`, `gst-plugins-good`, `gst-plugins-base`, ffmpeg 7.1
  with `h264_vaapi`, and gamescope with the PipeWire node always on in Game Mode. No SELinux and
  `/home` is mounted exec, so the same plugin zip should work unchanged.
