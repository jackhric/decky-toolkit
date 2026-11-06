# Decky Toolkit HTTP API

Base URL: `https://<deck-ip>:8765`. The server speaks TLS only (TLS 1.3); plain HTTP gets an empty reply.
Everything except `/`, `/health` and the pairing request routes (`/pair/request...`) requires a client
certificate issued at pairing (see [Authentication](#authentication)). There is no browser viewer, no
cookie and no bearer token: the live screen is the VS Code extension's screen panel, which reaches
these routes through its own loopback proxy.
Unauthorised requests get `401`; a request with an `Origin` header that does not point at this host
or loopback gets `403`. `GET /health` reports `api_version` (`3`; `3` added live sync); clients compare it before using
version-specific routes.

## Authentication

The device is its own certificate authority. On first start the plugin mints an EC P-256 key and a
self-signed certificate (`CN=Decky Toolkit`, 100 years) under `<settings dir>/tls/` (`server.crt`,
`server.key`, `clients.json`; directory `0700`, files `0600`, root). The certificate is both the
server certificate and the CA that signs client certificates. Nothing rotates it; deleting the directory
resets every pairing.

- The server requests a client certificate but does not require one, so `/health`, `/` and the pairing
  routes work without it. A certificate not signed by this CA fails the handshake.
- Every other route takes the SHA-256 fingerprint of the presented certificate (DER, hex) and requires it
  in the allow-list `clients.json` (`[{fingerprint, name, kind, added_at, last_seen}]`). A missing or
  forgotten certificate gets a plain `401`. Forgetting a client takes effect on its next request.
- Clients pin the server certificate they saw at pairing and verify it by fingerprint, not by host name.
- `curl` with the identity from a pairing: `--cert client.crt --key client.key --cacert server.crt`
  (add `-k` for the unauthenticated routes before pairing).

Status key: **live** = implemented and deployed, **planned** = agreed design, not yet implemented.

## Discovery

| Route | Auth | Status | Notes |
| --- | --- | --- | --- |
| `GET /health` | none | live | `{ok, name, version, api_version, tools, tools_hash, hostname, device_id, os}`. `tools_hash` (16 hex digits) changes whenever a tool, its description or its schema changes; the CLI's stdio MCP server compares it to send `notifications/tools/list_changed`. The last three identify the device to network discovery and hold nothing secret: `hostname` is the system hostname, `device_id` a 16-hex-digit SHA-256 of a namespace plus `/etc/machine-id` (stable per install, not reversible to the machine-id; `null` if unreadable), `os` the `PRETTY_NAME` from `/etc/os-release` (`null` if missing). Older builds omit them, and builds from before the rename report `name` `decky-mcp`. |
| mDNS `_decky-toolkit._tcp` | none | live | While the server listens on a non-loopback address, the plugin advertises it through the device's avahi-daemon (`avahi-publish`): instance name = short host name, SRV port = the server port, TXT `api=<api_version>`, `version=<version>`, `id=<device_id>`. Nothing is advertised if `avahi-publish` is missing. |
| `GET /` | none | live | one line of plain text saying the server runs and to connect with the VS Code extension |

## MCP

| Route | Auth | Status | Notes |
| --- | --- | --- | --- |
| `POST /mcp` | client cert | live | MCP Streamable HTTP, stateless, JSON replies only. Methods: `initialize`, `ping`, `tools/list`, `tools/call`. Notifications get `202`. |
| `GET /mcp` | client cert | live | `405` (no SSE stream) |
| `DELETE /mcp` | client cert | live | `200` (no sessions) |

## Screen

| Route | Auth | Status | Notes |
| --- | --- | --- | --- |
| `GET /stream.mjpeg` | client cert | live | `multipart/x-mixed-replace; boundary=frame`, JPEG parts with `Content-Length`. 30 fps default; see `/stream/settings`. A settings change keeps the connection open (about 0.1 s without frames, then the new rate/size). If the pipeline exits or goes 1.5 s without a frame (gamescope's stream renegotiating when Steam Game Recording starts or stops), the device restarts it with backoff and the connection stays open; clients see a pause, not an end. |
| `GET /frame.jpg` | client cert | live | One current JPEG frame. `503` with a reason if capture is unavailable. |
| `GET /stream/stats` | client cert | live | `{available, running, subscribers, fps, kbps, frames_total, uptime_s, width, height, settings{fps,quality,width,audio}, limits, restarts, last_restart_reason, node, audio, error}`. `restarts` counts automatic pipeline restarts since the plugin started. `node` (while running, refreshed at most every 5 s) is gamescope's PipeWire node: `{node_id, format, width, height, focus_appid, consumers}`; a nonzero `focus_appid` (set by Steam Game Recording, consumer `steam`) means gamescope paints only that app into the stream, without the Steam overlay. `audio` is the same object as `GET /audio/stats` (`null` without audio support). |
| `GET /stream/settings` | client cert | live | `{fps, quality, width, audio, limits: {fps: [1, 60], quality: [10, 100], widths: [0, 1600, 1280, 960, 640], audio: [false, true]}}`. `width` 0 = native; height follows the aspect ratio. `widths` lists suggested values; any width up to 3840 is accepted. `audio` (default `true`) streams what the device plays on `/audio`. `404` if capture is not configured. |
| `PUT /stream/settings` | client cert | live | JSON object with any subset of `fps`, `quality`, `width` (integers or integer strings) and `audio` (strict boolean). Out-of-range values are clamped (fps 1-60, quality 10-100, width 0-3840); non-integers, a non-boolean `audio` or unknown fields get `400 {"error"}` and change nothing. Persists to `settings.json` and, if the video pipeline is running and fps/quality/width changed, restarts it. `audio: false` closes every `/audio` socket with `4003` and stops the audio pipeline. Response: same shape as `GET`. Settings are device-wide: one pipeline serves every client, the last change wins. |

## Audio

What the device is playing: the default PipeWire sink's monitor (it follows changes of the default
sink; if no default sink can be linked, gamescope's own `gamescope` sink), as raw PCM. **On by
default** (`audio_enabled` in `settings.json`; `audio` in `/stream/settings`). The capture pipeline
starts with the first client and stops 10 s after the last one leaves.

| Route | Auth | Status | Notes |
| --- | --- | --- | --- |
| `GET /audio` | client cert | live | WebSocket. First a text frame `{"type":"format","codec":"pcm_s16le","rate":48000,"channels":2,"chunk_ms":20}`, then one binary frame per 20 ms: 3840 bytes of interleaved little-endian 16-bit stereo at 48 kHz (1536 kbit/s). Closes with `4003` (reason text) while audio is disabled or when it is disabled; `1011` if the pipeline fails. A client that falls behind loses the oldest chunks (at most 0.5 s is queued per client), so it never drifts. Client messages are ignored. |
| `GET /audio/stats` | client cert | live | `{enabled, available, running, subscribers, kbps, chunks_total, rms_db, uptime_s, source, format{codec,rate,channels,chunk_ms}, error}`. `rms_db` is the level of the last second in dBFS (`-120` for digital silence, `null` while stopped). `404` on servers without audio support. |

## Input

Remote keyboard, mouse and gamepad. **Off by default** (`input_enabled` in `settings.json`); while
off, the WebSocket closes with `4003` and the MCP input tools return an error. Keyboard and mouse go
through gamescope's libei server (`backend: "ei"`, `$XDG_RUNTIME_DIR/gamescope-{0,1}-ei`), else
through uinput devices (`"uinput"`). The gamepad is always a uinput Xbox 360 pad (045e:028e): either one
from `/controllers/virtual` (message field `pad`) or the implicit `auto` pad, created on first use and
removed 60 s after the last gamepad message.

| Route | Auth | Status | Notes |
| --- | --- | --- | --- |
| `GET /input/settings` | client cert | live | `{enabled, backend: "ei"\|"uinput"\|null, available, reason}`. `reason` explains `available: false`. `404` on servers without input support. |
| `PUT /input/settings` | client cert | live | `{"enabled": true\|false}` (strict boolean; anything else or extra fields: `400`). Persists. Disabling releases every held key/button, removes the keyboard/mouse devices and the implicit `auto` pad (pads from `/controllers/virtual` stay, back at neutral) and closes open `/input` sockets with `4003`. Same shape as `GET`. |
| `GET /input` | client cert | live | WebSocket. Closes with code `4003` (reason text) while input is disabled. On connect and whenever it changes the server sends `{"type":"state","enabled","backend","focus_size":[w,h]}`. Invalid messages get `{"type":"error","message"}`; the socket stays open. Any message with an `id` field is answered with `{"type":"ack","id"}` once injected. Everything the socket still holds (keys, mouse buttons, pad state) is released when it closes. The first input of a session from a new address logs it and emits `decky_toolkit_input_session` (at most once per address per 60 s). Rate cap about 1000 events/s; releases are never dropped. |

Client messages on `/input`:

| Message | Meaning |
| --- | --- |
| `{"type":"key","code":30,"down":true}` | evdev key code; or `"key":"KeyA"` (KeyboardEvent.code, `KEY_*` name, alias such as `ctrl`) |
| `{"type":"text","text":"hello"}` | US-layout ASCII, typed as key presses; other characters are an error |
| `{"type":"mouse_move","x":0.5,"y":0.5}` | absolute, normalised 0..1 across the focused window (scaled by `focus_size`) |
| `{"type":"mouse_move","dx":3,"dy":-1}` | relative, pixels (for API clients and the MCP tools; the screen panel only sends absolute moves) |
| `{"type":"mouse_button","button":"left","down":true}` | `left`, `right`, `middle`, `back`, `forward` (or DOM button numbers 0-4) |
| `{"type":"wheel","dx":0,"dy":-1}` | detents, positive `dy` scrolls down; sent to libei as 120 per detent |
| `{"type":"gamepad","buttons":{"a":true},"axes":{"lx":0,"ly":-1,"lt":0.5},"hat":[0,-1]}` | partial update of the pad (`"pad":"pad1"` targets a virtual pad from `/controllers/virtual`; default the implicit `auto` pad). Buttons `a b x y lb rb back start guide ls rs` and `dpad_up/down/left/right`; sticks `lx ly rx ry` -1..1 (down = +1), triggers `lt rt` 0..1; `hat` [x, y] in -1..1 |
| `{"type":"release_all"}` | release everything this socket holds (the screen panel sends it on blur) |

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
| `GET /controllers` | client cert | live | `{controllers: [Controller], virtual: [VirtualPad], input_enabled, steam_available}`. `404` on servers without input support. |
| `POST /controllers/virtual` | client cert | live | Body `{"name"?: str}` (optional; empty body allowed). Creates a pad, then waits up to 3 s for Steam Input to list it: `201 {id, name, type: "x360"}`. `503 {"error"}` if Steam Input is unreachable or never lists it (the pad is removed again) or uinput is unavailable; `400` for a bad body or when 4 explicit pads exist. Works while input is disabled (the pad exists; sending events needs input enabled). Explicit pads are never idle-removed. |
| `DELETE /controllers/virtual/{id}` | client cert | live | `200 {"removed": id}`, `404` if unknown. `auto` removes the implicit pad. |
| `GET /controllers/events` | client cert | live | `text/event-stream`. First event: the current state (`{"type":"controllers", controllers, virtual, input_enabled, steam_available}`), then `data: {"type":"controllers","controllers":[...],"virtual":[...]}` on every change: evdev polled every 1 s, Steam Input every 3 s and on evdev changes, immediately on pad add/remove. `last_event_at` alone does not count as a change. `: keepalive` every 15 s; the poller stops when the last client leaves. |

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
| `GET /ui/routes` | client cert | live | `{current, side_menu: "none"\|"main"\|"quick_access", quick_access_tab, active_plugin, official: [{path, title, template?}], plugins: [{plugin, path, title}], patched: [{plugin, path}], decky_plugins: [name], quick_access_tabs: [str], steam_routes: [str]}`. `official` is the verified list below; `template: true` entries take `{appid}` etc. `plugins` are routes registered through Decky's router hook (`DeckyPluginLoader.routerHook.routerState._routes`), `patched` its route patches (`_routePatches`); `plugin` is `Decky Loader` for `/decky/...`, else the plugin whose name appears in the path, else `unknown` (Decky does not record the owner). `steam_routes` is Steam's own route table (`routerHook.routes`). `502` if the Steam UI is unreachable. |
| `POST /ui/navigate` | client cert | live | Exactly one of: `{"path": "/library/home"}`, `{"action": "back"}`, `{"action": "quick_access", "tab"?: "decky"\|"notifications"\|"friends"\|"settings"\|"perf"\|"help"\|"soundtrack"\|...}`, `{"action": "main_menu"}`, `{"action": "close_menus"}`, `{"action": "plugin", "plugin": "<Decky plugin name>"}` (case-insensitive), `{"action": "app", "appid": 730}` (must be in the library). A path must be in `official` (or match a template), a plugin route, or Steam's route table; `/settings/<x>` only for the listed pages (Steam shows System for anything else). `/settings/controller` opens the first Steam Input controller's page. Navigating a path also closes open side menus. `200 {ok: true, current, side_menu, quick_access_tab, active_plugin}` read about 0.3 s later; `400 {"error"}` for an unknown route/action/tab/plugin/app (the message lists the known ones); `502` if the Steam UI is unreachable. |

Official routes (each opened on the device and checked on screen, 2026-11-04): `/library/home`, `/library`,
`/library/downloads`, `/library/app/{appid}`, `/search`, `/chat` (friends), `/steamweb` (store), `/about`,
`/accessibility`, `/settings` and `/settings/` + `system`, `internet`, `storage`, `bluetooth`, `display`,
`power`, `audio`, `keyboard`, `customization`, `accessibility`, `security`, `notifications`, `friends`,
`downloads`, `cloud`, `ingame`, `compatibility`, `family`, `remoteplay`, `gamerecording`, `home`, `library`,
`store`; `/settings/controller` and `/settings/controller/{type}/{index}`; `/decky/settings` + `/general`,
`/plugins`, `/developer`, `/testing`; `/decky/store`. Dropped because they render an empty page: `/store`,
`/downloads`, `/friends`, `/media`, `/settings/developer` (needs developer mode), `/settings/controller`
without parameters (shows System).

## Apps and game files

Library data comes from the Steam client in SharedJSContext (`appStore.allApps`, `SteamClient.Apps.RegisterForAppDetails`,
`SteamClient.InstallFolder.GetInstallFolders`, `SteamUIStore.RunningApps`); paths are resolved on disk as root, with
`~` meaning the desktop user's home (`DECKY_USER_HOME`). `appid` is a Steam appid or a non-Steam shortcut's id.
Errors: `400` bad argument, `403` sensitive path, `404` unknown app/path, `502` Steam UI unreachable.

| Route | Auth | Status | Notes |
| --- | --- | --- | --- |
| `GET /apps` | client cert | live | Query: `installed_only=1` (default; installed on this device), `query=<name substring or appid>`, `include_tools=1` (Proton, runtimes). `{count, apps: [{appid, name, type: game\|tool\|shortcut\|application\|..., installed, running, install_dir, compat_tool (e.g. "proton_11", "steamlinuxruntime_sniper" for native titles), compat_tool_display, size_on_disk, library, last_played (ISO), installed_elsewhere?, shortcut_exe?}]}` |
| `GET /apps/{appid}` | client cert | live | `app_info`: the list fields plus `gameid, developer, platforms, playtime_minutes, launch_options, build_id, cloud, processes` (when running) and `dirs` (as below). |
| `GET /apps/{appid}/dirs` | client cert | live | `game_dirs`: `{appid, name, developer, platform: proton\|native, compat_tool, steam_root, library, libraries, install_dir, manifest, compatdata, prefix, prefix_user_dirs: {appdata_roaming, appdata_local, appdata_locallow, documents, saved_games}, account_id, userdata, cloud_remote, remotecache, shader_cache, xdg, match_keys}`. Each dir is `{path, exists, mtime?}`; prefix user dirs add `matches` (subdirs named after the game or developer, two levels deep for Company/Product); `xdg` (native titles only) lists matching entries of `~/.local/share`, `~/.config`, `~/.config/unity3d` and `~`. |
| `GET /apps/{appid}/saves` | client cert | live | `game_saves`: `{appid, name, steam_cloud: [{name, root, size, time, local_path, candidates}], candidates: [{path, size, mtime, found_by, rank, score}], notes}`. Rank 0: files in Steam Cloud's `remotecache.vdf` mapped to local paths by their root (0 userdata remote, 2 Documents, 3 AppData/Local, ...; native titles also try the XDG dirs) and the cloud `remote/` dir; 1: files next to a `steam_autocloud.vdf` marker; 2: save-like files under dirs named after the game; 3: save-like names in the install dir. |
| `GET /fs` | client cert | live | `fs_list`. Query: `path` (absolute or `~/...`), `depth` 1-5 (default 1), `glob` (on the name, or on the relative path if it has a `/`). `{path, depth, glob, entries: [{path, type: file\|dir\|symlink\|other, size, mtime, target?, sensitive?}], count, truncated}`, at most 2000 entries. Sensitive files (Steam `config/loginusers.vdf`, `config/config.vdf`, `ssfn*`) are flagged in listings and refused (`403`) as the path itself, also through symlinks. |
| `GET /fs/read` | client cert | live | Query `path`. The file's bytes, `Content-Type: application/octet-stream`. Up to 64 MiB (`413`, code `EFBIG`, above). `403` for sensitive files, `404` missing, `409` `EISDIR` for a directory, `400` for a non-regular file. |
| `PUT /fs/write` | client cert | live | Query `path`, `create=1` (default; `0`: `404` if missing), `overwrite=1` (default; `0`: `409` `EEXIST` if present); body: the raw bytes (at most 64 MiB). Writes a temp file next to the target and renames it over; an existing file keeps its mode and owner, a new file is `0644` and, like any parent dirs it creates, owned by its parent dir's owner (the server runs as root, the game must still write its saves). `{path, bytes, created}`. Only inside the [write roots](#file-writes); `403` elsewhere and for `tools/guard` write-protected files. |
| `POST /fs/mkdir` | client cert | live | JSON `{path, parents?}` (or query `path`, `parents=1`). `409` `EEXIST` if it exists, `404` if the parent is missing without `parents`. Write roots apply. `{path, created}`. |
| `POST /fs/rename` | client cert | live | JSON `{from, to, overwrite?}`. Both paths must be inside the write roots (a symlink is moved, not its target); `409` `EEXIST` unless `overwrite`, `404` if `from` or the parent of `to` is missing; refuses a directory holding sensitive files. `{from, to}`. |
| `DELETE /fs` | client cert | live | Query `path`, `confirm=1` required (`400` without). Same rules as the `fs_delete` tool (game dir contents, compatdata/shadercache entries, `userdata/<account>/<appid>`, the plugin runtime dir); elsewhere `403`. `{deleted, files, bytes}`. |

`/fs/*` errors are `{"error", "code"}` with `code` one of `ENOENT` (404), `EACCES` (403), `EEXIST`, `EISDIR`, `ENOTDIR`
(409), `EFBIG` (413). These routes are audit-logged like every `POST`/`PUT`/`DELETE`.

### File writes

The server runs as root, so writes are limited to (`games.write_roots` / `games.writable`, resolved through symlinks):
inside `steamapps/common/<game>/` of any library, inside a Proton prefix `steamapps/compatdata/<appid>/`, inside
`userdata/<account>/<appid>/`, the plugin runtime dir (`~/homebrew/data/decky-toolkit`), and `~/.local/share/<dir>/...`,
`~/.config/<dir>/...` (`~/.config/unity3d/<company>/<product>/...`) where `<dir>` matches an installed title's name or
install dir as `game_dirs` matches them (not Steam's own dir or desktop config such as `systemd`, `autostart`, `fish`).
The entries themselves (a game dir, a prefix, a `~/.local/share/<Game>` dir) cannot be replaced. Everything in
`tools/guard.py` (`is_write_protected`) is refused everywhere.

## Recordings

`screen_record` subscribes to the live screen stream and the audio stream like a viewer and muxes their JPEG
frames and PCM chunks into Matroska (`V_MJPEG` + `A_PCM/INT/LIT` 48 kHz stereo) itself: no second gamescope
consumer, no re-encode, viewers are not affected. Resolution, quality and the maximum fps are the stream settings
(1080p q70 at 60 fps is about 12-13 MB/s). Files live in `DECKY_PLUGIN_RUNTIME_DIR/recordings/<name>.mkv`
(`<name>.mkv.part` while recording); at most 120 s, one recording at a time, refused with less than 2 GiB free.

| Route | Auth | Status | Notes |
| --- | --- | --- | --- |
| `GET /recordings` | client cert | live | `{dir, recordings: [{name, path, size, modified, download}], active: {name, path, seconds, fps, started}\|null, last: <result of the last recording or {error}>}` |
| `GET /recordings/{name}` | client cert | live | The file (`video/x-matroska`, `Content-Disposition: attachment`, range requests supported). `name` with or without `.mkv`; `400` for an invalid name, `404` if missing. |

## Pairing

A client asks for access, the device owner approves or denies it in the Decky panel (Quick Access →
Decky Toolkit: while a request is pending the panel shows only an "Approve <client>" button with the code). A device keeps several paired clients: approving a request adds that client to the allow-list next to the others (approving the same public key again keeps one entry and updates its name), and each one is forgotten on its own. There is no time limit: a request stays pending as long as its client
keeps polling. Requests live in memory, so a plugin restart forgets them (polls then get `404` and
the client files a new one).

| Route | Auth | Status | Notes |
| --- | --- | --- | --- |
| `POST /pair/request` | none (Origin checked) | live | JSON `{client_name, client_kind, public_key}`. `client_name`: 1-64 characters (whitespace collapsed); `client_kind`: `vscode` \| `mcp` \| `other` (default `other`); `public_key`: the client's EC P-256 public key as SPKI PEM (parsed; `400` otherwise). The private key never leaves the client. `201 {id, code, poll_after_ms}`: `id` is a 128-bit secret only the requester knows; `code` is 4 digits, `sha256(server cert DER + client SPKI DER + id)[:4]` read as a big-endian integer, mod 10000, zero-padded. The client derives the same code from the certificate it saw in the handshake and aborts if the device's differs; the user compares it with the code on the device. Two pending requests can share a code (the panel also shows the name). A new request from the same address and `client_name` replaces that client's pending one. `429 {"error"}` with 10 pending requests in total or 2 from the address; `400` for bad input. Emits `decky_toolkit_pair_request` (the device shows a toast). |
| `GET /pair/request/{id}` | none (Origin checked) | live | `?wait=<s>` (0-25, default 0) long-polls until the request is decided, dropped or the wait ends. Pending/denied: `{status}`. Approved: `{status: "approved", client_cert, server_cert, api_version}` (PEM strings; the certificate is signed for the submitted public key, `CN=<client_name>`, `clientAuth`, 100 years) on the first poll that sees the approval, `{status: "approved"}` afterwards. Unknown, cancelled, replaced or expired id: `404`. Every poll keeps the request alive. |
| `DELETE /pair/request/{id}` | none (Origin checked) | live | Cancels a pending request: `{cancelled: true}`, else `404`. |
| `GET /pair/requests` | client cert | live | Every request still held: `[{id, code, client_name, client_kind, remote, status, age_s}]`. |
| `GET /pair` | — | removed | The timed pairing window is gone; answers `404` for everyone. |

Expiry: a pending request that nobody polled for 60 s (and that has no poll waiting) is dropped; an
approved or denied one is kept for 5 minutes after the decision so its client can collect the
result. A prune runs every 10 s.

The Decky panel uses the frontend methods `list_pair_requests`, `approve_pair_request(id)` and
`deny_pair_request(id)` (each returns the list above), plus `list_paired_clients()` and
`forget_paired_client(fingerprint)` (both return the allow-list; each entry has `connected`, true when that client made an authenticated request in the last 15 s, kept in memory only, and `get_status()` has a top-level `connected`).
Entries also carry `connected_since` (epoch seconds when the current run of requests began, after a gap of 15 s or more; `null` while not connected) and `remote` (address of the last request, `null` if none since the plugin started); `get_status()` has `clients`, one `{name, kind, remote, connected_since, fingerprint, streaming}` per connected client (`[]` when none; `streaming` is true while that client holds a `/stream.mjpeg`).
`forget_paired_client` also closes that client's open connections at once, so its streams (MJPEG, SSE, WebSocket) end instead of running until it hangs up. There is no HTTP or MCP route to
approve a request or forget a client, and `call_plugin_method` refuses `approve_pair_request`,
`deny_pair_request` and `forget_paired_client` on this plugin: both need someone at the device.
`get_status()` no longer returns `url`.

## Plugins

| Route | Auth | Status | Notes |
| --- | --- | --- | --- |
| `POST /plugins/install` | client cert | live | Body: `multipart/form-data` with field `file` (a plugin zip as produced by the Decky CLI or the extension's deploy staging: either `<name>/...` as the single top-level dir, or files at the zip root). Query: `restart=loader` (default) \| `plugin` \| `none`. Validates `plugin.json` (string `name`, string `author`, list `flags`, int `api_version`) and refuses absolute paths, `..` and symlinks (`400 {"error"}`). The dir name is the zip's top-level dir, else `name` with spaces turned into `-`. Installs to `~/homebrew/plugins/<dirname>` atomically (unzip to a temp dir next to `plugins/`, D0755/F0644 root:root, swap). `version` comes from `package.json` (may be `null`). Response `{installed: {dir, name, version}, restarted: "loader"|"plugin"|"none"}`. `restart=loader`: the zip is unpacked to `~/homebrew/.decky-toolkit-pending/<dirname>` and, 1 s after the reply, a transient systemd unit stops the loader, swaps the dir in and starts the loader again (a swap the loader's file watcher sees while it is stopping leaves an orphaned, memory-leaking backend). `restart=plugin`: as `POST /plugins/{dir}/reload` after the swap; the plugin must already be loaded (a first install needs `loader`). `restart=none`: for a plugin with the `debug` flag the loader's file watcher re-imports it on its own 1-3 s later, usually twice (once per changed file); asking for `plugin` as well adds another reload. |
| `GET /plugins` | client cert | live | Same as the `list_plugins` tool. |
| `POST /plugins/{dir}/reload` | client cert | live | Re-import one plugin via Decky (`loader/reload_plugin`, called through `window.DeckyBackend` in SharedJSContext) without restarting the loader: the loader stops and restarts its backend, logs `Loaded <name> (v<version>)` and tells the frontend to import `dist/index.js` again (cache-busted), so both halves update (verified 2026-11-04, with and without the `debug` flag). `{dir, name, scheduled}`; reloading Decky Toolkit itself is deferred 1 s (`scheduled: true`). `404` if the dir has no `plugin.json`, `502` if the Steam UI is unreachable. With `?mode=frontend` (API 3) only the frontend is re-imported (Decky's `importPlugin`, ~10 ms; the backend keeps running); with `?mode=backend` the backend restarts too and the call returns once the new bundle is loaded. Both modes then restore the UI if the user was in the plugin: its Quick Access panel, its own route (only routes the plugin re-registered, and never over a running game), the selected settings tab and the gamepad focus. Response `{dir, name, mode, load_ms, reloaded, errors, restored, routes}`; `errors` are what the plugin logged through `console.error` while loading (bundle positions), `restored` lists what was put back. `mode=backend` for Decky Toolkit itself only schedules the restart (`scheduled: true`). |
| `PUT /plugins/{dir}/files` | client cert | live | API 3. Query `path` (relative to the installed plugin dir); body: the raw bytes. Replaces or creates that one file atomically (temp file + rename, `0644`), creating parent dirs. In-place writes do not trigger the loader's file watcher; follow with `POST /plugins/{dir}/reload?mode=…`. `400` for absolute paths, `..`, backslashes or a symlink leading out of the plugin dir, `403` for `tools/guard` write-protected names, `404` if `{dir}` has no `plugin.json`. `{dir, path, bytes}`. |
| `POST /loader/restart` | client cert | live | Same as the `restart_loader` tool. `{restarting: true, delay_s: 1}`. |
| `POST /exec` | client cert | live | JSON `{command, cwd?, timeout? (s, default 60, max 600), root? (default false), stdin?, max_output? (bytes per stream, default 65536, max 1 MiB)}`. Runs `bash -c command` in a new session as the desktop user (Decky's `DECKY_USER`: its `HOME`, `XDG_RUNTIME_DIR=/run/user/<uid>`, session D-Bus, `DISPLAY=:0`), or as root with `root: true`; no PyInstaller `LD_LIBRARY_PATH`. On timeout the process group gets SIGTERM, then SIGKILL after 2 s. Children left running in the background keep running; the reply comes 1 s after the shell exits (`background` says so). `{exit_code, stdout, stderr, timed_out, duration_ms, user, cwd, truncated?, background?}`; a non-zero exit is a `200`. Every command is written to the plugin log with user, cwd and client (the one place argument values are logged). A paired client could already run code as root by installing a plugin, so this adds no access. `400` for bad JSON, unknown fields or an empty command, `404` for a missing `cwd`. |

## Logs

| Route | Auth | Status | Notes |
| --- | --- | --- | --- |
| `GET /logs/stream` | client cert | live | `text/event-stream`. Query: `source=loader` (journal, default) \| `plugin`, `plugin=<dir>` for plugin logs (giving `plugin` alone implies `source=plugin`), `tail=<n>` initial lines (default 100, max 5000). Events: `data: <one log line>`; a comment `: keepalive` every 15 s. Plugin logs follow the newest file in `~/homebrew/logs/<dir>/` and switch when Decky starts a new one. |
| `GET /logs/tail` | client cert | live | Same filters, returns `{lines: [...]}` once. `404` if the plugin has no log dir. |

## Console

The Steam UI's own console, captured in the background from plugin start. One long-lived DevTools
session per watched tab (`SharedJSContext`, where Decky and every plugin frontend run, and `Steam Big
Picture Mode`) with `Runtime.enable` + `Log.enable`; it reconnects with backoff (1, 2, 5, 10 s) when CEF
restarts, e.g. after a loader restart, and starting it never waits for CEF. `Runtime.enable` makes V8
replay the messages it still holds, so the first attach after a plugin start also brings in the Steam
UI's history since its last reload; replays after a reconnect to the same page are skipped.

Entries: `{id, target, time, source, type, level, text, url?, line?, column?, function?}`. `id` is unique
and increasing across targets. `source`: `console` (`Runtime.consoleAPICalled`: `type` is the console
method, args rendered like DevTools from `Runtime.RemoteObject` previews, `%c` styling dropped, `%s`/`%d`/`%o`
substituted; `url`/`line`/`column`/`function` from the top stack frame, lines and columns 1-based),
`exception` (`Runtime.exceptionThrown`: `text` is e.g. `Uncaught Error: msg\n    at ...` or `Uncaught (in
promise) TypeError: ...`), or `log` (`Log.entryAdded`: `type` is the browser source, e.g. `network` for
failed resource loads, `violation`). `level`: `debug` < `log` = `info` < `warn` < `error`
(`console.warning`, `assert` -> `warn`/`error`; Log `verbose` -> `debug`). Each tab keeps 2000 entries,
plus a separate ring of 2000 for `debug`: Decky's WSRouter logs every backend call at debug level (a
plugin polling twice a second adds ~4 entries/s), which would otherwise push errors out within minutes.
Text is capped at 8000 characters.

| Route | Auth | Status | Notes |
| --- | --- | --- | --- |
| `GET /cef/console` | client cert | live | Query: `target` (`SharedJSContext` default, `Steam Big Picture Mode`, or `all`), `lines` (default 200), `level` (minimum, default `info`, i.e. everything but debug), `since` (entry id: newer entries; or ISO time, naive = device local time), `grep` (case-insensitive substring of text or url). `{target, status: [{target, connected, buffered, buffered_debug, dropped, connected_since, error}], last_id, count, entries}`. `400` for an unknown target/level or a bad `since`. |
| `GET /cef/console/stream` | client cert | live | `text/event-stream`. Query: `target` (as above, or `all`), `tail` (entries replayed first, default 100, max 5000), `level` (default `info`). Events: `data: <entry JSON>`; `: keepalive` every 15 s; a client disconnect stops the subscription within ~1 s (same handling as `/logs/stream`). |

Tools: `cef_console(target?, lines=200, level?="info", since?, grep?)` returns the same object as
`GET /cef/console`; `cef_console_clear(target?)` empties one tab's buffer, or all of them: `{cleared:
{target: n}}`.

## UI query

MCP tools only. They evaluate in a Steam UI tab (default `Steam Big Picture Mode`; `QuickAccess` and
`MainMenu` are the side menus, which are separate CEF child views; any tab title or title prefix works).

Element: `{tag, id, classes, text, label?, rect, norm, px, visible, focused}`. `text` is the element's
`innerText` with whitespace collapsed (160 characters max), `label` its `aria-label` (Steam's icon buttons
have only that). `rect` is the bounding rect in the tab's CSS px. `norm` `{x, y}` is the centre of the
element's on-screen part normalised 0..1 across the display, for `input_mouse` `x`/`y`; `px` the same
point in display pixels (1920x1080 stream). The Big Picture tab is 1353x761 CSS px at `devicePixelRatio`
1.42, so `norm` = centre / `innerWidth`,`innerHeight`. The side menus are placed by the parent window's
`m_rgChildBrowserViews[i].GetBounds()` (Quick Access: x 1005.5, y 40, 854x681 CSS px, mostly off screen to
the right; its own `screenX`/`screenY` read 0 after a Steam UI reload). `visible`: non-zero size,
`checkVisibility()` (display, visibility, opacity) and at least partly on the display. `focused`: Steam's
gamepad focus class `gpfocus` (its ancestors carry `gpfocuswithin`) or `document.activeElement`.

| Tool | Notes |
| --- | --- |
| `ui_query(selector?, text?, target?, limit=20)` | CSS selector and/or text (case-insensitive substring of `textContent` or `aria-label`; with text alone the innermost matching elements). Visible elements first, then exact text matches. `{target, total, elements}`. An invalid selector is an error naming it. |
| `ui_focus(target?)` | `{route, side_menu, target, window_focused, element, gpfocus?, active_element?}`. Without `target` it looks in the Quick Access or main menu view when one is open, else in Big Picture. `element` is the visible `.gpfocus` element (else `document.activeElement`); `gpfocus` lists all when there are several; `active_element` appears when `document.activeElement` is a different element. |
| `ui_wait_for(selector?, text?, route?, gone=false, timeout=10, interval=0.25, target?)` | Polls until a visible match exists (or, with `gone`, none does), or until the current route (`LocationPathName`) equals `route` (or, with `gone`, differs). `{ok, elapsed_s, element \| route}`. On timeout an error: `timed out after 10s waiting for route /x; current route /y, focus <div> 'System' at {...}`. CEF errors while polling (a tab briefly missing during a reload) count as "not yet". |

## Plugin calls

MCP tools only.

| Tool | Notes |
| --- | --- |
| `plugin_methods(dir)` | Parses (does not import) `<dir>/main.py` with `ast`: public `async def` methods of the top-level `class Plugin`. `{dir, file, methods: [{name, args: [{name, annotation?, default?}], doc, line}]}`; `*args`/`**kw` appear as `*name`/`**name`, `doc` is the first docstring line. |
| `call_plugin_method(plugin, method, args=[], timeout=30)` | `plugin` is the `plugin.json` name (e.g. `Decky Toolkit`). Keys named `token` are removed from `result` at any depth. Runs `window.DeckyBackend.call('loader/call_plugin_method', plugin, method, ...args)` in SharedJSContext, i.e. exactly what the plugin's frontend `callable()` does, over the frontend's existing loader connection. `{ok: true, result}`, or `{ok: false, error, traceback}`: Decky rejects with a `PyError` whose message is empty and whose `pythonTraceback` ends in the exception line (e.g. `Exception: port must be 1024-65535`); an unknown method also fails this way. Methods starting with `_` (lifecycle hooks) are refused before anything is sent. |
| `plugin_frontend_check(dir)` | Scans `<dir>/src/**/*.ts(x)` when sources are installed, else `dist/index.js`, for `callable("x")` / `call("x", ...)` (also `callable$1` and TS generics), and compares with `plugin_methods`. `{source: "src"\|"dist", files_scanned, frontend_calls: {name: ["file:line"]}, backend_methods, missing_backend, unused_backend}`. `missing_backend` entries fail at runtime. |

## Security

- Every route except the public ones needs a paired client certificate (see [Authentication](#authentication)).
- **Sensitive files.** `read_file` refuses, and `write_file` refuses to write, Steam login/session
  material and keys: `*/config/loginusers.vdf`, `*/config/config.vdf`, `ssfn*`, `*/local.vdf`, Steam's
  CEF cookie store (`*/htmlcache/*Cookies*`), `~/.ssh/id_*` (not `.pub`), `/etc/shadow`, `/etc/gshadow`.
  `write_file` also refuses `*/config/libraryfolders.vdf` and `*/steamapps/libraryfolders.vdf` (readable).
  Matching is case-insensitive on both the given and the symlink-resolved path. The list lives in
  `py_modules/decky_toolkit/tools/guard.py` (`is_sensitive`, `is_write_protected`, `check_read`,
  `check_write`); every tool that takes a device path calls it. The error is `PermissionError: refusing
  to read ...`.
- **Confirm.** `restart_loader` and `install_plugin` with `restart: "loader"` (the default) need
  `confirm: true`; without it they fail with a message saying so and do nothing. Future delete-type
  tools follow the same rule. The REST routes (`POST /loader/restart`, `POST /plugins/install`) need a
  paired client certificate instead.
- **Audit log.** Calls of `cef_evaluate`, `write_file`, `install_plugin`, `reload_plugin`,
  `restart_loader`, `call_plugin_method`, `input_*`, `set_input_enabled`, `remove_virtual_controller` and
  `ui_navigate` write one line to the plugin log (and the loader journal), before the tool runs:
  `audit tool=write_file origin=10.0.0.30 via=mcp args=content,path`. Only argument names the tool's
  schema declares are listed (others are counted, `+1 unknown`); values never are. Every authenticated
  `POST`/`PUT`/`DELETE` REST request except `/mcp` logs `audit route=POST /plugins/install origin=<ip>
  via=http`. The origin comes from the `audit.request_origin` context variable, set per request by an
  app middleware (`via=mcp` for `/mcp`, `http` otherwise).
- **Remote files.** `GET /fs/read`, `PUT /fs/write`, `POST /fs/mkdir`, `POST /fs/rename` and `DELETE /fs` need a
  paired client certificate, apply the sensitive-path guard, and write only inside the
  [write roots](#file-writes); `DELETE /fs` needs `confirm=1`.
- **Planned: per-client access levels.** Not implemented. A pairing could grant `observe` (screen, logs,
  console, routes, status), `standard` (plus input and navigation) or `full` (plus `cef_evaluate`,
  file writes, installs, plugin calls), checked in the tool registry and the REST routes, with the
  level shown in the approval prompt.

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
`tab`/`plugin`/`appid`, and `capture: true` for a frame 0.7 s later): as `/ui/...`. `ui_query`, `ui_focus`,
`ui_wait_for`: see [UI query](#ui-query). `cef_console`, `cef_console_clear`: see [Console](#console).
`plugin_methods`, `call_plugin_method`, `plugin_frontend_check`: see [Plugin calls](#plugin-calls).
`restart_loader` and `install_plugin` with `restart: "loader"` need `confirm: true` (see [Security](#security)).
`apps_list` (`installed_only`, `query`, `include_tools`), `app_info` (`appid`), `game_dirs` (`appid`),
`game_saves` (`appid`, `limit`): as `/apps...`. `apps_running`: `{running: [{appid, name, pid, processes}],
main_appid}`. `app_launch` (`appid`, `wait` s, default 15): `{launched, running}`, plus `game_actions` and a note
when Steam did not start it (a dialog). `app_terminate` (`appid`, `confirm: true` required, `wait`).
`fs_list` (`path`, `depth`, `glob`): as `/fs`. `fs_stat` (`path`). `fs_delete` (`path`, `confirm: true` required;
only inside `steamapps/common/<game>/...`, a `compatdata/<appid>` or `shadercache/<appid>` entry,
`userdata/<account>/<appid>/...` or the plugin runtime dir). `proton_log` (`appid`, `lines`): `~/steam-<appid>.log`
plus the matching lines of Steam's `logs/`. `screen_record` (`seconds` up to 120, `fps`, `with_audio`, `name`,
`wait`), `screen_record_stop`, `recordings_list`, `recording_delete` (`name`, `confirm: true` required): see
Recordings. `perf_overlay` (`level` 0-4, `show_over_steam`), `perf_overlay_status`: Steam's MangoHud overlay level as
on the Quick Access performance tab (`SteamClient.System.Perf.UpdateSettings`); gamescope does not paint this
external overlay into its PipeWire stream, so captures and recordings never show it.

## Events (backend → Decky frontend)

| Event | Payload | Meaning |
| --- | --- | --- |
| `decky_toolkit_pair_request` | `{id, code, client_name, client_kind, remote}` | a client asked to pair; toast "<client_name> wants to pair · code <code>" |
| `decky_toolkit_pair_requests` | the `list_pair_requests` list | requests were filed, decided, cancelled or expired; the panel refreshes |
| `decky_toolkit_paired` | `remote_ip: string, client_name: string` | a pairing request was allowed on the device |
| `decky_toolkit_paired_clients` | the `list_paired_clients` list | a client was added or forgotten; the panel refreshes |
| `decky_toolkit_input_session` | `remote_ip: string` | a client started sending input (`"MCP client"` for tool calls); the panel shows a toast |

## Errors

Non-MCP routes return plain text or `{"error": "<message>"}` with a conventional status code.
MCP tool failures are returned inside the JSON-RPC result with `isError: true`, never as HTTP errors.
