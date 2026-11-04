# Decky Toolkit — notes for agents working in this repo

## What this is
A Decky Loader plugin whose Python backend hosts an MCP Streamable-HTTP server (port 8765, bearer
token) so external coding agents can inspect/control the Steam Deck during plugin development.
See README.md for setup and docs/reference.md for the tool list and architecture.

## Layout
- `main.py` — Decky `Plugin` class: settings, aiohttp server lifecycle, frontend-callable methods.
- `py_modules/decky_toolkit/` — `protocol.py` (JSON-RPC + HTTP transport), `http.py` (REST routes, see
  `docs/api.md`), `auth.py`, `tools/` (tool registry and tools), `install.py` (plugin zip
  validation + atomic install), `logs.py` (journal / plugin log tail and follow), `cdp.py` (Chrome
  DevTools client for Steam CEF on 127.0.0.1:8080), `settings.py`, `input/` (remote input: `ei.py`
  libei over ctypes, `uinput.py`, `keymap.py`, `service.py` owning state and the virtual pad registry; tools
  in `tools/input.py`), `controllers.py` (Steam Input controller list + evdev merge, virtual pad
  creation confirmed by Steam; tools in `tools/controllers.py`), `ui.py` (Steam UI navigation; tools
  in `tools/ui.py`).
- `src/index.tsx` — Quick Access panel (React, `@decky/ui`, `@decky/api`). Built by `pnpm run build`
  into `dist/index.js`.
- `scripts/test.sh` — Python tests under uv with the loader's Python major (CI runs it). Deploying this repo to
  a device is done with the extension itself (it detects the root `plugin.json`); there are no ssh scripts.
- `scripts/install-gif/record.sh` — re-records `docs/images/install/vscode-install.gif` (official VS Code under
  Xvfb driven by Playwright, installing the published extension); needs node, xvfb-run, ffmpeg.

## Runtime facts (verified on the target device, 2026-11-03)
- Device: Bazzite `bazzite-deck-44.20261012`, host `bazzite`, IP 10.0.70.18, user `jackh`
  (wheel, passwordless sudo). SSH key auth works. Hostname does not resolve from the dev box; use the IP.
- Decky Loader v3.3.1 at `~/homebrew/services/PluginLoader`, runs as root. Bundled CPython is
  **3.14.8** (PyInstaller, extracted to `/tmp/_MEI*`). Plugin backends run as the loader's forkserver
  children; `py_modules/` is appended to `sys.path`. `aiohttp`, `yarl`, `multidict`, `certifi` are
  importable from the bundle. Do not ship cp311 wheels; prefer pure Python.
- `~/homebrew/plugins` is root-owned 755. The install route unpacks to a staging dir next to it and
  swaps the plugin dir in as root.
- Loader HTTP API is `127.0.0.1:1337` (token via `GET /auth/token`, header `X-Decky-Auth`). Its
  websocket is single-client — never connect to it from the plugin.
- Steam CEF debugger is `127.0.0.1:8080` (file `~/.steam/steam/.cef-enable-remote-debugging` exists).
  Target titles seen: `SharedJSContext`, `Steam Big Picture Mode`, `QuickAccess_uid2`, `MainMenu_uid2`,
  `notificationtoasts_uid2`.
- firewalld zone `FedoraWorkstation` allows TCP/UDP 1025-65535 inbound, so no firewall change needed.
  SELinux is enforcing; the loader binary is labelled `bin_t` by `ujust setup-decky`.
- Port 8887 is taken by decky-wine-cellar's backend; avoid it.

## Loader behaviour that shaped the code
- `_main` is scheduled as a task (may run forever); `_unload` gets SIGTERM and is SIGKILLed after 5 s,
  hence `shutdown_timeout=2` on the AppRunner.
- A loader crash orphans plugin processes (decky-loader #975/#983); the orphan's socket reader spins
  on EOF and leaked 6 GB before the OOM killer got it (observed 2026-11-03). Python 3.14 uses the
  forkserver start method, so the parent PID is the forkserver helper, not the loader; the
  `_loader_watchdog` thread tracks the grandparent loader PID (plus start time) and `os._exit`s.
- The loader's file watcher loads a plugin whose files change even while shutting down, so a
  `restart=loader` install stops the loader before swapping the dir in.
- Subprocesses inherit the PyInstaller `LD_LIBRARY_PATH`; `tools.system.clean_env` strips it.
- `"debug"` in `plugin.json` flags enables hot reload on `dist/index.js`/`main.py` changes. An
  install through `/plugins/install` swaps the whole dir, so for a debug-flagged plugin the watcher
  reloads its backend ~5 s later (twice, observed 2026-11-03) even with `restart=none`.
- `window.DeckyBackend.call('loader/reload_plugin', '<plugin.json name>')` in SharedJSContext
  reloads one backend in ~0.1 s (verified 2026-11-03); this is how `reload_plugin` avoids the
  single-client loader websocket.

## Plugin reload facts (verified 2026-11-04)
- `loader/reload_plugin` (via the Steam JS context) reloads a plugin's backend and frontend bundle and does
  NOT require the `debug` flag. With `debug`, the loader's own file watcher additionally reloads the plugin
  twice after its files change, so the extension uses `restart=none` for debug plugins and lets the watcher
  do it. The watcher never imports a brand-new plugin dir; a first install needs a loader restart.
- A `restart=loader` install that swapped the plugin dir while the loader was running raced the watcher and
  left orphaned backends leaking memory; the install route now stages the dir and a systemd job stops the
  loader, swaps, and starts it.

## Screen streaming facts (verified 2026-11-03)
- gamescope publishes a PipeWire `Video/Source` node named `gamescope` (BGRx/NV12 1920x1080) that
  delivers 60 fps while the screen changes and **nothing at all while it is static**. A fresh
  consumer on a static screen gets zero frames; `gamescopectl debug_force_repaint` (DISPLAY=:1,
  XDG_RUNTIME_DIR=/run/user/1000) or `gamescopectl screenshot` makes it paint once, and
  `pipewiresrc keepalive-time=100` keeps re-emitting the last buffer afterwards.
- Never force a caps format directly after `pipewiresrc` (a failed negotiation can kill the node
  until gamescope restarts, gamescope #2508); keep `! video/x-raw ! videoconvert`.
- `videorate` backfills gaps with duplicates; without `max-duplication-time` a long stall turns
  into a burst of hundreds of frames.
- 1080p JPEG q70 at 30 fps is ~50 Mbit/s; `gst-launch-1.0` as root with `env -i` plus
  XDG_RUNTIME_DIR works.
- 60 fps keeps up (verified 2026-11-04, BC-250, 12 cores): 1080p q70 delivers 300 parts per 5 s with
  every frame unique, `/stream/stats` 60.0 fps, gst-launch 33-40 % of one core. Bitrate is content
  bound: ~97 Mbit/s on the detailed library page (~200 KB/frame), 30-50 Mbit/s on simpler screens.
  30 fps: 23 % CPU, ~48 Mbit/s on the same page; 15 fps: 13-16 %, ~24 Mbit/s. 1280 wide at 60 fps:
  ~28 Mbit/s, 30 % CPU. videoconvert runs before videorate, so CPU does not fall linearly with fps.
- **Stopping a consumer with SIGTERM/SIGKILL while gamescope is painting into its PipeWire buffers
  crashes gamescope** (terra-gamescope 3.16.31: SIGSEGV in `paint_pipewire` -> `vulkan_screenshot`,
  coredumps 2026-11-04; it takes the whole Steam session down and back up). 6 of ~30 hot restarts
  crashed it with `terminate()`; 0 of ~22 since `ScreenCapturer.stop` sends SIGINT, which makes
  gst-launch go through PAUSED (stream deactivated) before disconnecting. A loader restart still
  SIGTERMs the whole cgroup, so restarting the loader while a stream is live can still crash it.
- gamescope's caps say `pixel-aspect-ratio=1/2147483647`; `videoscale` to a width then picks height 1
  (or keeps 1080 with a non-square PAR), so the scaled branch sets PAR 1/1 with `capssetter` first.
- Stream settings are device-wide (one pipeline). `ScreenCapturer.update_settings` is the single
  path for the panel method, `PUT /stream/settings` and the `set_stream_settings` tool; a hot restart
  keeps subscribers attached (`_restarting`), so viewers see ~0.1 s without frames, no reconnect. Port 8080 (CEF) drops for a few seconds after every loader restart because
  Decky reloads the Steam UI.
- Stock SteamOS 3.8.14 (Valve recovery image, inspected by a research agent) ships gstreamer 1.26.4,
  gst-plugin-pipewire 1.6.4, gst-plugins-good/base, ffmpeg 7.1.1 (h264_vaapi), gamescope 3.16.23
  with PipeWire always on, libturbojpeg.so.0, libjpeg.so.8 (not .62), libva.so.2, libx264.so.164.
  No GStreamer VA/x264 encoders. `holo-base` Docker image lacks all of these and is not a proxy.

## Games, Steam Game Recording and the shared gamescope stream (verified 2026-11-04)
- gamescope has **one** PipeWire stream; every consumer shares its port format. Steam's background Game
  Recording (`CDesktopCapturePipeWire` in `~/.local/share/Steam/logs/streaming_log.txt`, recordings
  `bg_<appid>_...`) links to it as node `steam` when a game starts and unlinks when it quits. Its format
  carries gamescope's custom keys 0x70000 `requested_size` (Steam asks 3840x2160) and 0x70001
  `focus_appid` (`pw-dump`: `id-00070000`/`id-00070001`; `/stream/stats` `node.focus_appid`).
- `paint_pipewire` (gamescope `src/steamcompmgr.cpp`) composites its own layer set, independent of
  scanout/`composite_force`: with `focus_appid` 0 it paints the current focus plus the Steam overlay
  window; with a nonzero appid it paints only that app's windows (`!ulFocusAppId && overlayWindow`), and
  nothing at all if no window of that app exists (`bAppIdMatches`).
- A consumer joining an already-negotiated port inherits its format: if our pipeline is running first,
  Steam's recorder gets appid 0 and the Guide/QAM overlay shows in our stream during games (verified:
  main menu visible over VVVVVV). But Steam calls `pw_stream_update_params` ("updating capture appid: N")
  when the game it records differs from its previous capture appid (e.g. a different game than last
  time); that renegotiates the port for everyone: gamescope logs "Exposing appid N focus-wise on pipewire
  stream", our stream shows only the game (no overlay; verified with Castle Crashers), and our
  `pipewiresrc` often wedges: gst-launch stays alive, emits nothing (keepalive too), and gamescope logs
  `pipewire: warning: out of buffers` ~60/s. Old code: a 56 s freeze (ended only when another consumer
  left), and a fresh second consumer got zero buffers meanwhile.
- When the game quits, Steam unlinks but the port keeps `focus_appid` = the dead game, so gamescope paints
  nothing and the stream froze indefinitely (old code, VVVVVV). Reconnecting with no other consumer
  linked renegotiates from scratch with appid 0.
- Fix: `ScreenCapturer._watchdog` treats 1.5 s without a frame (4 s before the first) as wedged and
  restarts the pipeline with SIGINT and backoff 0.25/1/2/5/10 s, keeping subscribers attached; an
  unexpected exit restarts the same way. Measured: game quit -> 1.9 s gap, then frames with appid 0;
  launch with renegotiation -> 8 s + 3.7 s gaps (3 restarts) while gamescope had no window for the new
  appid yet, later 1.9 s; launches without renegotiation -> no gap. No gamescope coredumps.
- Not fixable from our side: while Steam's recorder holds a nonzero appid the overlay is not in the
  stream (`gst-launch` cannot set gamescope's custom format keys). Mitigation: set Steam Game Recording
  to off or "record manually" so no consumer sets a focus appid.
- Launching a game while the account plays elsewhere opens a "Launching X here will disconnect the other
  session" dialog with Continue focused; cancel it (`SteamClient.Apps.CancelGameAction(id)` plus the
  dialog's Cancel button in "Steam Big Picture Mode"), never press A.
- Audio is unaffected by game launch/quit (`/audio/stats` chunks continuous, same default sink).

## Audio streaming facts (verified 2026-11-04)
- Sinks: only `alsa_output.pci-0000_01_00.1.hdmi-surround` (5.1 HDMI, DENON-AVR), which is
  `default.audio.sink`; no `gamescope` Audio/Sink existed at the time (`audio.py` falls back to
  `target-object=gamescope` only if the default fails with "target not found").
- WirePlumber 0.5.17 spells the monitor flag **`stream.capture.sink`** (dots). `stream.capture-sink`
  is silently ignored and every capture stream fails with "target not found"/"no target node
  available". `pulsesrc` as root fails too (pipewire-pulse refuses a root client on uid 1000's dir).
- Pipeline (as root with `XDG_RUNTIME_DIR=/run/user/1000`): `gst-launch-1.0 -q pipewiresrc
  stream-properties=props,stream.capture.sink=true,node.name=decky-toolkit-audio ! audioconvert !
  audioresample ! audio/x-raw,format=S16LE,rate=48000,channels=2,layout=interleaved ! fdsink fd=1
  sync=false`. Without `target-object` it follows the default sink. audioconvert downmixes the 5.1
  monitor: a stereo 440 Hz test tone at amplitude 3000 arrives at -23.8 dBFS (rms 2121, unchanged).
- Cost: gst-launch 0.4-0.7 % of one core, 16 MB RSS; the backend adds well under 1 % per client.
  1536 kbit/s, 50.1 chunks/s of 3840 bytes. First chunk ~50 ms after connect (cold pipeline start).
- `date` on the device right before `pw-play` to the first loud chunk at a LAN client: 175-215 ms,
  which includes pw-play's own startup; browser playback adds its ~120 ms buffer.
- Stopped with SIGINT like the video pipeline; it is gone 10 s after the last client (checked at 16 s).
- AudioWorklet only exists in secure contexts: the viewer on `http://<ip>:8765` falls back to
  scheduled AudioBufferSources; via localhost or the VS Code webview it uses the worklet. Both paths
  measured -25.7 dBFS at the output node for the -23.8 dBFS tone at volume 0.8 (headless Chromium).
- Chromium checks AudioWorklet modules against `script-src` (not `worker-src`), so the webview CSP
  needs `blob:` in `script-src` for the inline worklet.

## Remote input facts (verified 2026-11-04)
- gamescope's EIS socket is `/run/user/1000/gamescope-0-ei`; `ctypes.CDLL("libei.so.1")` (1.6.0) works
  from the loader's bundled Python as root, and the bundle ships `_ctypes`/`libffi`. gamescope offers
  one device ("Gamescope Virtual Input") with every capability and a region of INT32_MAX, so the
  region says nothing about the focused window size.
- Absolute libei moves land exactly: (0.6, 0.5) -> 1152,540 and back to 960,540 in the Steam UI
  (`xdotool getmouselocation` on `:0` as uid 1000). WS round trip for a move with ack: median
  ~0.5 ms on the LAN.
- `runuser -u jackh -- env DISPLAY=:0 xdotool getwindowfocus getwindowgeometry` gives the focused
  window (Steam UI: 1920x1080); on `:1` it fails (focus is the root window).
- The uinput X360 pad (045e:028e) appears in `/proc/bus/input/devices` and Steam wraps it as
  "Microsoft X-Box 360 pad 1" (28de:11ff) within ~2 s; removing our device removes Steam's wrapper.
- Hidden cursor rests at 1919,1079 in the Steam UI.

## Controllers and UI navigation facts (verified 2026-11-04, Steam client 1792618285)
- Steam Input is the source of the controller list; never bypass it (user requirement: no CDP gamepad
  emulation, no XTest, no writing to Steam's own virtual devices; gamepad events only go into our uinput pads).
- `SteamClient.Input` on this build has **no** `GetControllerInfo`/`RegisterForControllerListChanges`
  (enumerated with `Object.keys`; it has `RegisterForActiveControllerChanges`,
  `RegisterForUnboundControllerListChanges`, `RegisterForControllerInputMessages`, ...). The list lives in
  `window.ControllerStore` (SharedJSContext): its `Init` registers `RegisterForNotifyControllerListChanged`
  on Steam's protobuf Input service and `DoControllerListQuery` fills `m_controllerList`. We read
  `ControllerStore.GetControllers()` (ControllerInfo: `nControllerIndex`, `nXInputIndex`, `eControllerType`,
  `strName`, `unVendorID`, `unProductID`, `strSerialNumber`, `bWireless`, `bBluetooth`, `ucBatteryLevel`; the
  `unCapabilities` field is a BigInt, so `JSON.stringify` of the raw object throws), plus
  `GetControllerTypeString(eControllerType)` (`controller_xbox360`), `m_nLastValidActiveControllerIndex`
  and `LocalizationManager.LocalizeString('#controller_xboxone')` -> "Xbox One controller". Field names from
  decky-frontend-lib `src/globals/steam-client/Input.ts` (`ControllerInfo`, `EControllerType`).
- Our uinput X360 pad is listed by Steam Input within ~1 s as type 31 `controller_xbox360`, name
  "Controller N", vendor 1118 product 654, serial like `45e-28e-5b2bb70` (a second pad got the same with a
  `g` suffix; serials get reused). Steam keeps listing a removed pad for 1-2 s. Steam also creates its own
  output pad per controller (`28de:11ff` "Microsoft X-Box 360 pad N" under `/devices/virtual/input`);
  those are excluded from the list. `controller.txt` logs "Product: Xbox 360 Controller" per pad.
- Navigation: `window.DFL.Navigation` (@decky/ui `Navigation`, source `decky-frontend-lib`
  `src/modules/Router.ts`) is reachable in SharedJSContext. It calls `Navigate`/`NavigateBack` on
  `SteamUIStore.GetFocusedWindowInstance()` (falls back to `WindowStore.GamepadUIMainWindowInstance`) and
  `OpenQuickAccessMenu`/`OpenMainMenu`/`CloseSideMenus` on its `MenuStore`. `DFL.QuickAccessTab` is the enum
  (Notifications 0 ... VRBatteries 8, Decky 999). `MenuStore.GetOpenSideMenu()` 0 none/1 main/2 quick access.
- Visible page: `SteamUIStore.WindowStore.GamepadUIMainWindowInstance.LocationPathName` (e.g.
  `/library/home`); SharedJSContext's `location.pathname` is `/routes/library/home` and the
  "Steam Big Picture Mode" tab's location is just `index.html?...`.
- `LocationPathName` echoes any path you navigate to, valid or not, so it cannot validate a route. Steam's
  route table is `DeckyPluginLoader.routerHook.routes` (React route elements, `props.path`); settings
  sub-pages are the `identifier`s of the settings dialog's `pages` prop (found through the React fiber of
  the sidebar), and an unknown `/settings/<x>` silently shows System. The verified list is `ui.OFFICIAL`.
- Decky: plugin routes are `DeckyPluginLoader.routerHook.routerState._routes` (Map path -> {component,
  props}) and `_routePatches`; the owner plugin is not recorded (decky-loader `frontend/src/router-hook.tsx`).
  Opening a plugin panel = `DeckyPluginLoader.deckyState.setActivePlugin(name)` (decky-loader
  `frontend/src/components/DeckyState.tsx`) then `OpenQuickAccessMenu(999)`.

## Self-update
`update.py` reads `https://jackhric.github.io/decky-toolkit/update.json` (written by `pages.yml` from the latest
published `plugin-v*` release: version, sha256, size, release asset URL) 30 s after start and every 6 h, and
with `auto_update` (default on) installs a newer release through `tools.plugins.install(..., "loader")` once no
screen/audio subscriber is attached (busy: retry every 10 min). Surfaces: panel (version row, check/update
button, toggle under Advanced), `/update`, `/update/check`, `/update/apply`, `PUT /update/settings`, tools
`check_toolkit_update`/`apply_toolkit_update`/`set_toolkit_auto_update`, extension command
`decky-toolkit.updateToolkit`, event `decky_toolkit_update`. `SERVER_INFO.version` (`/health`) comes from
`DECKY_PLUGIN_VERSION`, which the loader sets from `package.json`. A dev device with a from-source deploy should
have auto-update off or the next release overwrites it.

## Pairing
A client files `POST /pair/request` and long-polls `GET /pair/request/{id}?wait=25`; the device owner
approves or denies it in the panel, which shows only an "Approve pairing request?" prompt while one is
pending (frontend methods `list_pair_requests`,
`approve_pair_request`, `deny_pair_request`). No time limit. Requests live in memory
(`py_modules/decky_toolkit/pairing.py`): a pending one expires 60 s after its last poll, a decided one 5 min
after the decision, and a plugin restart forgets them all, so clients re-request (new code) on a 404.
The token goes out once per approval; the browser flow gets the cookie via `?cookie=1` instead.
Approval is deliberately device-only (no HTTP/MCP route), the one exception to the remote-configurable
rule below. `/mcp` always requires the bearer token. Events: `decky_toolkit_pair_request` (toast with name
and code), `decky_toolkit_pair_requests` (list changed), `decky_toolkit_paired` (remote IP, client name). To
drive frontend methods from a test, evaluate
`window.DeckyBackend.call('loader/call_plugin_method', 'Decky Toolkit', '<method>', ...args)` in
SharedJSContext via the `cef_evaluate` tool.

## CI and releases
- Work branches off `dev` and PRs target `dev`; `dev` is merged into `main` to release. CI runs on PRs and
  pushes for both branches; release-please only runs on `main`.
- `.github/workflows/ci.yml`: plugin (typecheck, build, zip), Python tests, extension (typecheck, build,
  smoke, package). Also called by `release.yml`.
- Versions are bumped only by release-please (`release-please-config.json`, `.release-please-manifest.json`)
  from conventional commits: never edit the `version` in `package.json` or `extension/package.json` by
  hand. Components `plugin` (repo root, excluding `extension/`) and `extension`; tags `plugin-vX.Y.Z` /
  `extension-vX.Y.Z`. Merging the release PR creates draft releases plus tags; `release.yml` checks the tag
  against package.json, runs CI, attaches the zip / `.vsix`, publishes the draft, and publishes extension
  releases to Open VSX and the VS Code Marketplace by trusted publishing (OIDC, environments `openvsx` and
  `marketplace`, no token secrets).
- Node matches Decky Loader's own CI (`node-version: 26` in SteamDeckHomebrew/decky-loader workflows).
- GitHub Pages (`pages.yml`, source: GitHub Actions) serves the site plus the latest plugin release as
  `jackhric.github.io/decky-toolkit/decky-toolkit.zip`, the Decky "Install Plugin from URL" link. It deploys on
  plugin releases (called from `release.yml`), on pushes to `main` touching `site/`, and by hand. A deploy
  replaces the whole site, so the future Astro landing page (`site/`) must be built in this workflow.
  Plugin releases also carry a fixed-name `decky-toolkit.zip` and are the repo's "Latest" release.
- Every third-party action is pinned to a full commit SHA with a `# vX.Y.Z` comment; Dependabot bumps them.
  Keep it that way. The release-please App key lives in the `release` environment (main only).
- PRs are squash-merged with the PR title as the commit message, so the PR title is what release-please
  reads; `pr-title.yml` enforces a conventional title (`feat:`, `fix:`, `feat!:` for breaking, ...).

## Conventions
- Every setting is configurable remotely (approving a pairing request is not a setting): through an MCP tool, the HTTP API (for the extension) and
  the web viewer where it applies. The Decky panel only mirrors state (it polls `get_status` and
  listens for change events); it never holds a setting that cannot be changed remotely.
- Keep the MCP server dependency-free beyond the loader bundle (aiohttp + stdlib).
- Tools return str/dict (serialised to text) or a list of MCP content blocks. Raise `ValueError`
  for bad input; other exceptions become `isError` results with a traceback.
- Comments only for non-obvious *why*; match the sparse style.
