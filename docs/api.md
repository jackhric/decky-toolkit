# Decky Toolkit HTTP API

Base URL: `http://<deck-ip>:8765`. Everything except `/`, `/health`, the pairing request routes
(`/pair/request...`) and the viewer's own token handling requires either `Authorization: Bearer <token>` or the `decky_toolkit_token`
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
| `GET /viewer` | self | live | HTML viewer. `?token=<t>` sets the cookie and redirects. Without a valid cookie: `401` with the "Request access" page (`static/pair.html`), which files a pairing request (`client_kind: "browser"`) and, once it is allowed on the device, gets the cookie through `?cookie=1`. |
| `GET /stream.mjpeg` | bearer/cookie | live | `multipart/x-mixed-replace; boundary=frame`, JPEG parts with `Content-Length`. 30 fps default; see `/stream/settings`. A settings change keeps the connection open (about 0.1 s without frames, then the new rate/size). If the pipeline exits or goes 1.5 s without a frame (gamescope's stream renegotiating when Steam Game Recording starts or stops), the device restarts it with backoff and the connection stays open; clients see a pause, not an end. |
| `GET /frame.jpg` | bearer/cookie | live | One current JPEG frame. `503` with a reason if capture is unavailable. |
| `GET /stream/stats` | bearer/cookie | live | `{available, running, subscribers, fps, kbps, frames_total, uptime_s, width, height, settings{fps,quality,width,audio}, limits, restarts, last_restart_reason, node, audio, error}`. `restarts` counts automatic pipeline restarts since the plugin started. `node` (while running, refreshed at most every 5 s) is gamescope's PipeWire node: `{node_id, format, width, height, focus_appid, consumers}`; a nonzero `focus_appid` (set by Steam Game Recording, consumer `steam`) means gamescope paints only that app into the stream, without the Steam overlay. `audio` is the same object as `GET /audio/stats` (`null` without audio support). |
| `GET /stream/settings` | bearer/cookie | live | `{fps, quality, width, audio, limits: {fps: [1, 60], quality: [10, 100], widths: [0, 1600, 1280, 960, 640], audio: [false, true]}}`. `width` 0 = native; height follows the aspect ratio. `widths` lists suggested values; any width up to 3840 is accepted. `audio` (default `true`) streams what the device plays on `/audio`. `404` if capture is not configured. |
| `PUT /stream/settings` | bearer/cookie | live | JSON object with any subset of `fps`, `quality`, `width` (integers or integer strings) and `audio` (strict boolean). Out-of-range values are clamped (fps 1-60, quality 10-100, width 0-3840); non-integers, a non-boolean `audio` or unknown fields get `400 {"error"}` and change nothing. Persists to `settings.json` and, if the video pipeline is running and fps/quality/width changed, restarts it. `audio: false` closes every `/audio` socket with `4003` and stops the audio pipeline. Response: same shape as `GET`. Settings are device-wide: one pipeline serves every viewer, the last change wins. Cookie auth is accepted so the browser viewer can change them. |

## Audio

What the device is playing: the default PipeWire sink's monitor (it follows changes of the default
sink; if no default sink can be linked, gamescope's own `gamescope` sink), as raw PCM. **On by
default** (`audio_enabled` in `settings.json`; `audio` in `/stream/settings`). The capture pipeline
starts with the first client and stops 10 s after the last one leaves.

| Route | Auth | Status | Notes |
| --- | --- | --- | --- |
| `GET /audio` | bearer/cookie | live | WebSocket. First a text frame `{"type":"format","codec":"pcm_s16le","rate":48000,"channels":2,"chunk_ms":20}`, then one binary frame per 20 ms: 3840 bytes of interleaved little-endian 16-bit stereo at 48 kHz (1536 kbit/s). Closes with `4003` (reason text) while audio is disabled or when it is disabled; `1011` if the pipeline fails. A client that falls behind loses the oldest chunks (at most 0.5 s is queued per client), so it never drifts. Client messages are ignored. |
| `GET /audio/stats` | bearer/cookie | live | `{enabled, available, running, subscribers, kbps, chunks_total, rms_db, uptime_s, source, format{codec,rate,channels,chunk_ms}, error}`. `rms_db` is the level of the last second in dBFS (`-120` for digital silence, `null` while stopped). `404` on servers without audio support. |

## Input

Remote keyboard, mouse and gamepad. **Off by default** (`input_enabled` in `settings.json`); while
off, the WebSocket closes with `4003` and the MCP input tools return an error. Keyboard and mouse go
through gamescope's libei server (`backend: "ei"`, `$XDG_RUNTIME_DIR/gamescope-{0,1}-ei`), else
through uinput devices (`"uinput"`). The gamepad is always a uinput Xbox 360 pad (045e:028e): either one
from `/controllers/virtual` (message field `pad`) or the implicit `auto` pad, created on first use and
removed 60 s after the last gamepad message.

| Route | Auth | Status | Notes |
| --- | --- | --- | --- |
| `GET /input/settings` | bearer/cookie | live | `{enabled, backend: "ei"\|"uinput"\|null, available, reason}`. `reason` explains `available: false`. `404` on servers without input support. |
| `PUT /input/settings` | bearer/cookie | live | `{"enabled": true\|false}` (strict boolean; anything else or extra fields: `400`). Persists. Disabling releases every held key/button, removes the keyboard/mouse devices and the implicit `auto` pad (pads from `/controllers/virtual` stay, back at neutral) and closes open `/input` sockets with `4003`. Same shape as `GET`. Cookie auth is accepted so the viewer can toggle it. |
| `GET /input` | bearer/cookie | live | WebSocket. Closes with code `4003` (reason text) while input is disabled. On connect and whenever it changes the server sends `{"type":"state","enabled","backend","focus_size":[w,h]}`. Invalid messages get `{"type":"error","message"}`; the socket stays open. Any message with an `id` field is answered with `{"type":"ack","id"}` once injected. Everything the socket still holds (keys, mouse buttons, pad state) is released when it closes. The first input of a session from a new address logs it and emits `decky_toolkit_input_session` (at most once per address per 60 s). Rate cap about 1000 events/s; releases are never dropped. |

Client messages on `/input`:

| Message | Meaning |
| --- | --- |
| `{"type":"key","code":30,"down":true}` | evdev key code; or `"key":"KeyA"` (KeyboardEvent.code, `KEY_*` name, alias such as `ctrl`) |
| `{"type":"text","text":"hello"}` | US-layout ASCII, typed as key presses; other characters are an error |
| `{"type":"mouse_move","x":0.5,"y":0.5}` | absolute, normalised 0..1 across the focused window (scaled by `focus_size`) |
| `{"type":"mouse_move","dx":3,"dy":-1}` | relative, pixels (for API clients and the MCP tools; the viewers only send absolute moves) |
| `{"type":"mouse_button","button":"left","down":true}` | `left`, `right`, `middle`, `back`, `forward` (or DOM button numbers 0-4) |
| `{"type":"wheel","dx":0,"dy":-1}` | detents, positive `dy` scrolls down; sent to libei as 120 per detent |
| `{"type":"gamepad","buttons":{"a":true},"axes":{"lx":0,"ly":-1,"lt":0.5},"hat":[0,-1]}` | partial update of the pad (`"pad":"pad1"` targets a virtual pad from `/controllers/virtual`; default the implicit `auto` pad). Buttons `a b x y lb rb back start guide ls rs` and `dpad_up/down/left/right`; sticks `lx ly rx ry` -1..1 (down = +1), triggers `lt rt` 0..1; `hat` [x, y] in -1..1 |
| `{"type":"release_all"}` | release everything this socket holds (the viewer sends it on blur) |

`focus_size` is the focused X window on `:0` (`xdotool getwindowfocus getwindowgeometry` as the
desktop user, cached 1 s, `[1920,1080]` if unknown). libei absolute coordinates are in that window's
pixels, so for a game rendering below the display resolution `x`/`y` map onto the game window, not
the whole screen.

## Controllers

Steam Input is the source of truth. The list comes from `window.ControllerStore` in the Steam UI's
SharedJSContext, the store Steam itself fills from its Input service (`RegisterForNotifyControllerListChanged`
plus `DoControllerListQuery`; `SteamClient.Input` on this Steam build has no controller-list call).
Each Steam entry is paired with a kernel evdev node from `/proc/bus/input/devices` (gamepads = devices with
`BTN_GAMEPAD` in their key bitmap; Steam Input's own output pads, `28de:11ff` "Microsoft X-Box 360 pad N",
are not inputs and are left out). An evdev gamepad Steam Input does not list is still shown, with
`seen_by_steam: false` and `steam: null`. If the Steam UI is unreachable (2 s timeout) every entry has
`steam: null` and `steam_available` is `false`.

Virtual pads are uinput Xbox 360 pads (045e:028e) that Steam Input opens and maps like a real controller;
gamepad events go only into that device, so Steam Input's remapping and per-game configs apply.

| Route | Auth | Status | Notes |
| --- | --- | --- | --- |
| `GET /controllers` | bearer/cookie | live | `{controllers: [Controller], virtual: [VirtualPad], input_enabled, steam_available}`. `404` on servers without input support. |
| `POST /controllers/virtual` | bearer/cookie | live | Body `{"name"?: str}` (optional; empty body allowed). Creates a pad, then waits up to 3 s for Steam Input to list it: `201 {id, name, type: "x360"}`. `503 {"error"}` if Steam Input is unreachable or never lists it (the pad is removed again) or uinput is unavailable; `400` for a bad body or when 4 explicit pads exist. Works while input is disabled (the pad exists; sending events needs input enabled). Explicit pads are never idle-removed. |
| `DELETE /controllers/virtual/{id}` | bearer/cookie | live | `200 {"removed": id}`, `404` if unknown. `auto` removes the implicit pad. |
| `GET /controllers/events` | bearer/cookie | live | `text/event-stream`. First event: the current state (`{"type":"controllers", controllers, virtual, input_enabled, steam_available}`), then `data: {"type":"controllers","controllers":[...],"virtual":[...]}` on every change: evdev polled every 1 s, Steam Input every 3 s and on evdev changes, immediately on pad add/remove. `last_event_at` alone does not count as a change. `: keepalive` every 15 s; the poller stops when the last client leaves. |

`Controller`: `{id, name, kind: "physical"|"virtual", virtual_id, vendor, product, device, evdev_name,
seen_by_steam, steam}`. `id` is the virtual pad id for our pads, else `steam:<serial>` or `evdev:<inputN>`.
`vendor`/`product` are 4-digit lowercase hex. `device` is `/dev/input/eventN` or `null` (Steam reads some
controllers, e.g. the Deck's own, through hidraw). `steam` (all from Steam Input's `ControllerInfo`):
`{type, slot, name, index, type_name, active}` = `GetControllerTypeString(eControllerType)` (e.g.
`controller_xbox360`), `nXInputIndex` (null when negative), `strName` localised through
`LocalizationManager.LocalizeString` (Steam names virtual pads "Controller N"), `nControllerIndex`, the
localised type name ("Xbox 360 controller"), and whether `nControllerIndex` equals
`ControllerStore.m_nLastValidActiveControllerIndex`. Our pads are paired with Steam's entries by the
`strSerialNumber` Steam assigned when it confirmed the pad. Steam keeps listing a removed pad for a second or
two; the list hides it for up to 5 s.

`VirtualPad`: `{id, name, type: "x360", created_at, last_event_at, auto}` (epoch seconds). `auto: true` is the
implicit pad (`id: "auto"`) that a gamepad message without `pad` creates; it is removed 60 s after its last
event and when input is disabled. Explicit pads (`pad1`, `pad2`, ...) survive input being disabled (they are
returned to neutral) and are removed by `DELETE`, a plugin restart or the plugin unloading.

## UI navigation

Uses @decky/ui's `Navigation` (`window.DFL.Navigation` in SharedJSContext): `Navigate`, `NavigateBack`,
`OpenQuickAccessMenu(QuickAccessTab)`, `OpenMainMenu`, `CloseSideMenus`. A Decky plugin's panel opens through
`window.DeckyPluginLoader.deckyState.setActivePlugin(name)` plus the Quick Access menu on the Decky tab. The
visible page is `SteamUIStore.WindowStore.GamepadUIMainWindowInstance.LocationPathName` (SharedJSContext's own
`location` is `/routes/...` of the hidden context).

| Route | Auth | Status | Notes |
| --- | --- | --- | --- |
| `GET /ui/routes` | bearer/cookie | live | `{current, side_menu: "none"\|"main"\|"quick_access", quick_access_tab, active_plugin, official: [{path, title, template?}], plugins: [{plugin, path, title}], patched: [{plugin, path}], decky_plugins: [name], quick_access_tabs: [str], steam_routes: [str]}`. `official` is the verified list below; `template: true` entries take `{appid}` etc. `plugins` are routes registered through Decky's router hook (`DeckyPluginLoader.routerHook.routerState._routes`), `patched` its route patches (`_routePatches`); `plugin` is `Decky Loader` for `/decky/...`, else the plugin whose name appears in the path, else `unknown` (Decky does not record the owner). `steam_routes` is Steam's own route table (`routerHook.routes`). `502` if the Steam UI is unreachable. |
| `POST /ui/navigate` | bearer/cookie | live | Exactly one of: `{"path": "/library/home"}`, `{"action": "back"}`, `{"action": "quick_access", "tab"?: "decky"\|"notifications"\|"friends"\|"settings"\|"perf"\|"help"\|"soundtrack"\|...}`, `{"action": "main_menu"}`, `{"action": "close_menus"}`, `{"action": "plugin", "plugin": "<Decky plugin name>"}` (case-insensitive), `{"action": "app", "appid": 730}` (must be in the library). A path must be in `official` (or match a template), a plugin route, or Steam's route table; `/settings/<x>` only for the listed pages (Steam shows System for anything else). `/settings/controller` opens the first Steam Input controller's page. Navigating a path also closes open side menus. `200 {ok: true, current, side_menu, quick_access_tab, active_plugin}` read about 0.3 s later; `400 {"error"}` for an unknown route/action/tab/plugin/app (the message lists the known ones); `502` if the Steam UI is unreachable. |

Official routes (each opened on the device and checked on screen, 2026-11-04): `/library/home`, `/library`,
`/library/downloads`, `/library/app/{appid}`, `/search`, `/chat` (friends), `/steamweb` (store), `/about`,
`/accessibility`, `/settings` and `/settings/` + `system`, `internet`, `storage`, `bluetooth`, `display`,
`power`, `audio`, `keyboard`, `customization`, `accessibility`, `security`, `notifications`, `friends`,
`downloads`, `cloud`, `ingame`, `compatibility`, `family`, `remoteplay`, `gamerecording`, `home`, `library`,
`store`; `/settings/controller` and `/settings/controller/{type}/{index}`; `/decky/settings` + `/general`,
`/plugins`, `/developer`, `/testing`; `/decky/store`. Dropped because they render an empty page: `/store`,
`/downloads`, `/friends`, `/media`, `/settings/developer` (needs developer mode), `/settings/controller`
without parameters (shows System).

## Pairing

A client asks for access, the device owner approves or denies it in the Decky panel (Quick Access →
Decky Toolkit: while a request is pending the panel shows only an "Approve pairing request?" prompt). There is no time limit: a request stays pending as long as its client
keeps polling. Requests live in memory, so a plugin restart forgets them (polls then get `404` and
the client files a new one).

| Route | Auth | Status | Notes |
| --- | --- | --- | --- |
| `POST /pair/request` | none (Origin checked) | live | JSON `{client_name, client_kind}`. `client_name`: 1-64 characters (whitespace collapsed); `client_kind`: `vscode` \| `browser` \| `mcp` \| `other` (default `other`). `201 {id, code, poll_after_ms}`: `id` is a 128-bit secret only the requester knows, `code` 4 digits, unique among pending requests, shown on the device so the user can match it. A new request from the same address and `client_name` replaces that client's pending one. `429 {"error"}` with 10 pending requests in total or 2 from the address; `400` for bad input. Emits `decky_toolkit_pair_request` (the device shows a toast). |
| `GET /pair/request/{id}` | none (Origin checked) | live | `?wait=<s>` (0-25, default 0) long-polls until the request is decided, dropped or the wait ends. Pending/denied: `{status}`. Approved: `{status: "approved", token, url, api_version}` on the first poll that sees the approval (`url` is `http://<ip>:<port>`), `{status: "approved"}` afterwards. `?cookie=1` on an approved request sets the viewer cookie and redirects to `/viewer` (once; again: `410`). Unknown, cancelled, replaced or expired id: `404`. Every poll keeps the request alive. |
| `DELETE /pair/request/{id}` | none (Origin checked) | live | Cancels a pending request: `{cancelled: true}`, else `404`. |
| `GET /pair/requests` | bearer/cookie | live | Every request still held: `[{id, code, client_name, client_kind, remote, status, age_s}]`. |
| `GET /pair` | — | removed | The timed pairing window is gone; answers `404` for everyone. |

Expiry: a pending request that nobody polled for 60 s (and that has no poll waiting) is dropped; an
approved or denied one is kept for 5 minutes after the decision so its client can collect the
result. A prune runs every 10 s.

The Decky panel uses the frontend methods `list_pair_requests`, `approve_pair_request(id)` and
`deny_pair_request(id)` (each returns the list above). There is no HTTP or MCP route to approve a
request: approval needs someone at the device.

## Plugins

| Route | Auth | Status | Notes |
| --- | --- | --- | --- |
| `POST /plugins/install` | bearer | live | Body: `multipart/form-data` with field `file` (a plugin zip as produced by the Decky CLI or the extension's deploy staging: either `<name>/...` as the single top-level dir, or files at the zip root). Query: `restart=loader` (default) \| `plugin` \| `none`. Validates `plugin.json` (string `name`, string `author`, list `flags`, int `api_version`) and refuses absolute paths, `..` and symlinks (`400 {"error"}`). The dir name is the zip's top-level dir, else `name` with spaces turned into `-`. Installs to `~/homebrew/plugins/<dirname>` atomically (unzip to a temp dir next to `plugins/`, D0755/F0644 root:root, swap). `version` comes from `package.json` (may be `null`). Response `{installed: {dir, name, version}, restarted: "loader"|"plugin"|"none"}`. `restart=loader`: the zip is unpacked to `~/homebrew/.decky-toolkit-pending/<dirname>` and, 1 s after the reply, a transient systemd unit stops the loader, swaps the dir in and starts the loader again (a swap the loader's file watcher sees while it is stopping leaves an orphaned, memory-leaking backend). `restart=plugin`: as `POST /plugins/{dir}/reload` after the swap; the plugin must already be loaded (a first install needs `loader`). `restart=none`: for a plugin with the `debug` flag the loader's file watcher re-imports it on its own 1-3 s later, usually twice (once per changed file); asking for `plugin` as well adds another reload. |
| `GET /plugins` | bearer/cookie | live | Same as the `list_plugins` tool. |
| `POST /plugins/{dir}/reload` | bearer | live | Re-import one plugin via Decky (`loader/reload_plugin`, called through `window.DeckyBackend` in SharedJSContext) without restarting the loader: the loader stops and restarts its backend, logs `Loaded <name> (v<version>)` and tells the frontend to import `dist/index.js` again (cache-busted), so both halves update (verified 2026-11-04, with and without the `debug` flag). `{dir, name, scheduled}`; reloading Decky Toolkit itself is deferred 1 s (`scheduled: true`). `404` if the dir has no `plugin.json`, `502` if the Steam UI is unreachable. |
| `POST /loader/restart` | bearer | live | Same as the `restart_loader` tool. `{restarting: true, delay_s: 1}`. |

## Logs

| Route | Auth | Status | Notes |
| --- | --- | --- | --- |
| `GET /logs/stream` | bearer/cookie | live | `text/event-stream`. Query: `source=loader` (journal, default) \| `plugin`, `plugin=<dir>` for plugin logs (giving `plugin` alone implies `source=plugin`), `tail=<n>` initial lines (default 100, max 5000). Events: `data: <one log line>`; a comment `: keepalive` every 15 s. Plugin logs follow the newest file in `~/homebrew/logs/<dir>/` and switch when Decky starts a new one. |
| `GET /logs/tail` | bearer/cookie | live | Same filters, returns `{lines: [...]}` once. `404` if the plugin has no log dir. |

## MCP tools (live)

`decky_status`, `list_plugins`, `read_plugin_log`, `loader_log`, `restart_loader`, `cef_targets`,
`cef_evaluate`, `cef_screenshot`, `toast`, `screen_capture`, `stream_status` (includes `settings`,
`limits` and `audio`), `set_stream_settings` (`fps`, `quality`, `width`, `audio`, as `PUT /stream/settings`), `read_file`,
`write_file`, `install_plugin` (`path` on the device or `zip_base64`, plus `restart` as for
`POST /plugins/install`), `reload_plugin` (`dir`), `set_input_enabled` (`enabled`), `input_key`
(`keys` combo string such as `"ctrl+shift+a"` or a list of combos, `hold_ms`), `input_text` (`text`,
`delay_ms`), `input_mouse` (`action` move/click/double/down/up/scroll, `x`/`y` 0..1 or pixels with
`pixels: true`, `dx`/`dy`, `button`, `amount`), `input_gamepad` (`buttons`, `axes`, `hat`, `hold_ms`,
`sequence`, `pad`: a virtual pad id, default the implicit `auto` pad). Every input tool takes `capture: true` to append a fresh screen frame, and refuses with
an error while input is disabled. `list_controllers`, `add_virtual_controller` (`name`),
`remove_virtual_controller` (`id`): as `/controllers`. `ui_routes`, `ui_navigate` (`path` or `action` plus
`tab`/`plugin`/`appid`, and `capture: true` for a frame 0.7 s later): as `/ui/...`.

## Events (backend → Decky frontend)

| Event | Payload | Meaning |
| --- | --- | --- |
| `decky_toolkit_pair_request` | `{id, code, client_name, client_kind, remote}` | a client asked to pair; toast "<client_name> wants to pair · code <code>" |
| `decky_toolkit_pair_requests` | the `list_pair_requests` list | requests were filed, decided, cancelled or expired; the panel refreshes |
| `decky_toolkit_paired` | `remote_ip: string, client_name: string` | a pairing request was allowed on the device |
| `decky_toolkit_input_session` | `remote_ip: string` | a client started sending input (`"MCP client"` for tool calls); the panel shows a toast |

## Errors

Non-MCP routes return plain text or `{"error": "<message>"}` with a conventional status code.
MCP tool failures are returned inside the JSON-RPC result with `isError: true`, never as HTTP errors.
