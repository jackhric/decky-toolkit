# Decky-MCP HTTP API

Base URL: `http://<deck-ip>:8765`. Everything except `/`, `/health`, `/pair` and the viewer's own
token / pairing handling requires either `Authorization: Bearer <token>` or the `decky_mcp_token`
cookie; routes marked "bearer" refuse the cookie.
Unauthorised requests get `401`; a request with an `Origin` header that does not point at this host
or loopback gets `403`. `GET /health` reports `api_version`; clients compare it before using
version-specific routes.

Status key: **live** = implemented and deployed, **planned** = agreed design, not yet implemented.

## Discovery

| Route | Auth | Status | Notes |
| --- | --- | --- | --- |
| `GET /health` | none | live | `{ok, name, version, api_version, tools}` |
| `GET /` | none | live | redirects to `/viewer` |

## MCP

| Route | Auth | Status | Notes |
| --- | --- | --- | --- |
| `POST /mcp` | bearer/cookie | live | MCP Streamable HTTP, stateless, JSON replies only. Methods: `initialize`, `ping`, `tools/list`, `tools/call`. Notifications get `202`. |
| `GET /mcp` | bearer/cookie | live | `405` (no SSE stream) |
| `DELETE /mcp` | bearer/cookie | live | `200` (no sessions) |

## Screen

| Route | Auth | Status | Notes |
| --- | --- | --- | --- |
| `GET /viewer` | self | live | HTML viewer. `?token=<t>` sets the cookie and redirects. During a pairing window an unauthenticated request also gets the cookie. |
| `GET /stream.mjpeg` | bearer/cookie | live | `multipart/x-mixed-replace; boundary=frame`, JPEG parts with `Content-Length`. 30 fps default; see `/stream/settings`. A settings change keeps the connection open (about 0.1 s without frames, then the new rate/size). |
| `GET /frame.jpg` | bearer/cookie | live | One current JPEG frame. `503` with a reason if capture is unavailable. |
| `GET /stream/stats` | bearer/cookie | live | `{available, running, subscribers, fps, kbps, frames_total, uptime_s, width, height, settings{fps,quality,width}, limits, error}` |
| `GET /stream/settings` | bearer/cookie | live | `{fps, quality, width, limits: {fps: [1, 60], quality: [10, 100], widths: [0, 1600, 1280, 960, 640]}}`. `width` 0 = native; height follows the aspect ratio. `widths` lists suggested values; any width up to 3840 is accepted. `404` if capture is not configured. |
| `PUT /stream/settings` | bearer/cookie | live | JSON object with any subset of `fps`, `quality`, `width` (integers or integer strings). Out-of-range values are clamped (fps 1-60, quality 10-100, width 0-3840); non-integers or unknown fields get `400 {"error"}` and change nothing. Persists to `settings.json` and, if the pipeline is running and something changed, restarts it. Response: same shape as `GET`. Settings are device-wide: one pipeline serves every viewer, the last change wins. Cookie auth is accepted so the browser viewer can change them. |

## Input

Remote keyboard, mouse and gamepad. **Off by default** (`input_enabled` in `settings.json`); while
off, the WebSocket closes with `4003` and the MCP input tools return an error. Keyboard and mouse go
through gamescope's libei server (`backend: "ei"`, `$XDG_RUNTIME_DIR/gamescope-{0,1}-ei`), else
through uinput devices (`"uinput"`). The gamepad is always a uinput Xbox 360 pad (045e:028e), created
on first use and removed 60 s after the last gamepad message.

| Route | Auth | Status | Notes |
| --- | --- | --- | --- |
| `GET /input/settings` | bearer/cookie | live | `{enabled, backend: "ei"\|"uinput"\|null, available, reason}`. `reason` explains `available: false`. `404` on servers without input support. |
| `PUT /input/settings` | bearer/cookie | live | `{"enabled": true\|false}` (strict boolean; anything else or extra fields: `400`). Persists. Disabling releases every held key/button, removes the virtual devices and closes open `/input` sockets with `4003`. Same shape as `GET`. Cookie auth is accepted so the viewer can toggle it. |
| `GET /input` | bearer/cookie | live | WebSocket. Closes with code `4003` (reason text) while input is disabled or the pairing window is open. On connect and whenever it changes the server sends `{"type":"state","enabled","backend","focus_size":[w,h]}`. Invalid messages get `{"type":"error","message"}`; the socket stays open. Any message with an `id` field is answered with `{"type":"ack","id"}` once injected. Everything the socket still holds (keys, mouse buttons, pad state) is released when it closes. The first input of a session from a new address logs it and emits `decky_mcp_input_session` (at most once per address per 60 s). Rate cap about 1000 events/s; releases are never dropped. |

Client messages on `/input`:

| Message | Meaning |
| --- | --- |
| `{"type":"key","code":30,"down":true}` | evdev key code; or `"key":"KeyA"` (KeyboardEvent.code, `KEY_*` name, alias such as `ctrl`) |
| `{"type":"text","text":"hello"}` | US-layout ASCII, typed as key presses; other characters are an error |
| `{"type":"mouse_move","x":0.5,"y":0.5}` | absolute, normalised 0..1 across the focused window (scaled by `focus_size`) |
| `{"type":"mouse_move","dx":3,"dy":-1}` | relative, pixels (pointer-lock / game mode) |
| `{"type":"mouse_button","button":"left","down":true}` | `left`, `right`, `middle`, `back`, `forward` (or DOM button numbers 0-4) |
| `{"type":"wheel","dx":0,"dy":-1}` | detents, positive `dy` scrolls down; sent to libei as 120 per detent |
| `{"type":"gamepad","buttons":{"a":true},"axes":{"lx":0,"ly":-1,"lt":0.5},"hat":[0,-1]}` | partial update of the pad. Buttons `a b x y lb rb back start guide ls rs` and `dpad_up/down/left/right`; sticks `lx ly rx ry` -1..1 (down = +1), triggers `lt rt` 0..1; `hat` [x, y] in -1..1 |
| `{"type":"release_all"}` | release everything this socket holds (the viewer sends it on blur) |

`focus_size` is the focused X window on `:0` (`xdotool getwindowfocus getwindowgeometry` as the
desktop user, cached 1 s, `[1920,1080]` if unknown). libei absolute coordinates are in that window's
pixels, so for a game rendering below the display resolution `x`/`y` map onto the game window, not
the whole screen.

## Pairing

| Route | Auth | Status | Notes |
| --- | --- | --- | --- |
| `GET /pair` | none, only while pairing is open | live | Returns `{token, url, api_version}` (`url` is `http://<ip>:<port>`, no path) so a client (VS Code extension, CLI) can obtain the token during the 120 s window opened from the Decky panel. Outside the window: `403 {"error":"pairing closed"}`; a foreign `Origin` also gets `403`. Each grant increments the panel's pairing counter and emits the `decky_mcp_paired` event. |

## Plugins

| Route | Auth | Status | Notes |
| --- | --- | --- | --- |
| `POST /plugins/install` | bearer | live | Body: `multipart/form-data` with field `file` (a plugin zip as produced by the Decky CLI or `scripts/deploy.sh` staging: either `<name>/...` as the single top-level dir, or files at the zip root). Query: `restart=loader` (default) \| `plugin` \| `none`. Validates `plugin.json` (string `name`, string `author`, list `flags`, int `api_version`) and refuses absolute paths, `..` and symlinks (`400 {"error"}`). The dir name is the zip's top-level dir, else `name` with spaces turned into `-`. Installs to `~/homebrew/plugins/<dirname>` atomically (unzip to a temp dir next to `plugins/`, D0755/F0644 root:root, swap). `version` comes from `package.json` (may be `null`). Response `{installed: {dir, name, version}, restarted: "loader"|"plugin"|"none"}`. With `restart=loader` the reply is sent before the restart fires 1 s later. |
| `GET /plugins` | bearer/cookie | live | Same as the `list_plugins` tool. |
| `POST /plugins/{dir}/reload` | bearer | live | Reload one plugin's backend via Decky (`loader/reload_plugin`, called through `window.DeckyBackend` in SharedJSContext) without restarting the loader. `{dir, name, scheduled}`; reloading Decky-MCP itself is deferred 1 s (`scheduled: true`). `404` if the dir has no `plugin.json`, `502` if the Steam UI is unreachable. |
| `POST /loader/restart` | bearer | live | Same as the `restart_loader` tool. `{restarting: true, delay_s: 1}`. |

## Logs

| Route | Auth | Status | Notes |
| --- | --- | --- | --- |
| `GET /logs/stream` | bearer/cookie | live | `text/event-stream`. Query: `source=loader` (journal, default) \| `plugin`, `plugin=<dir>` for plugin logs (giving `plugin` alone implies `source=plugin`), `tail=<n>` initial lines (default 100, max 5000). Events: `data: <one log line>`; a comment `: keepalive` every 15 s. Plugin logs follow the newest file in `~/homebrew/logs/<dir>/` and switch when Decky starts a new one. |
| `GET /logs/tail` | bearer/cookie | live | Same filters, returns `{lines: [...]}` once. `404` if the plugin has no log dir. |

## MCP tools (live)

`decky_status`, `list_plugins`, `read_plugin_log`, `loader_log`, `restart_loader`, `cef_targets`,
`cef_evaluate`, `cef_screenshot`, `toast`, `screen_capture`, `stream_status` (includes `settings`
and `limits`), `set_stream_settings` (`fps`, `quality`, `width`, as `PUT /stream/settings`), `read_file`,
`write_file`, `install_plugin` (`path` on the device or `zip_base64`, plus `restart` as for
`POST /plugins/install`), `reload_plugin` (`dir`), `set_input_enabled` (`enabled`), `input_key`
(`keys` combo string such as `"ctrl+shift+a"` or a list of combos, `hold_ms`), `input_text` (`text`,
`delay_ms`), `input_mouse` (`action` move/click/double/down/up/scroll, `x`/`y` 0..1 or pixels with
`pixels: true`, `dx`/`dy`, `button`, `amount`), `input_gamepad` (`buttons`, `axes`, `hat`, `hold_ms`,
`sequence`). Every input tool takes `capture: true` to append a fresh screen frame, and refuses with
an error while input is disabled.

## Events (backend → Decky frontend)

| Event | Payload | Meaning |
| --- | --- | --- |
| `decky_mcp_paired` | `remote_ip: string` | a client was granted access during pairing |
| `decky_mcp_input_session` | `remote_ip: string` | a client started sending input (`"MCP client"` for tool calls); the panel shows a toast |

## Errors

Non-MCP routes return plain text or `{"error": "<message>"}` with a conventional status code.
MCP tool failures are returned inside the JSON-RPC result with `isError: true`, never as HTTP errors.
