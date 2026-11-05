# MCP and automation tooling for Steam Deck / SteamOS: survey and gap analysis (2026-11-04)

Scope: projects that give AI agents (MCP or similar) tools for the Steam Deck, SteamOS, Bazzite, gamescope,
Decky Loader or the Steam client, and the device APIs those tools are built on. Repos were read from shallow
clones; no code from them was run. Dates are the last commit on the default branch. Tool counts come from the
registration sites linked below. **(unverified)** marks claims taken from a README, a search listing or a
subagent summary rather than from source.

## 0. Decky Toolkit today (baseline)

**26 MCP tools** (registered in `py_modules/decky_toolkit/tools/*.py`; Streamable HTTP on `:8765/mcp`, on the device,
bearer token from on-device pairing):

| Group | Tool | What it does |
|---|---|---|
| System (`system.py`) | `decky_status` | Decky version, OS release, Python, installed plugins |
| | `list_plugins` | `~/homebrew/plugins/*` with `plugin.json` metadata |
| | `read_plugin_log` | tail a plugin's log file in `~/homebrew/logs/<dir>/` |
| | `loader_log` | tail the `plugin_loader.service` journal |
| | `restart_loader` | restart `plugin_loader.service` (scheduled 1 s out) |
| | `read_file` / `write_file` | read or write any file as root (absolute path) |
| Plugins (`plugins.py`) | `install_plugin` | install a zip (device path or base64) atomically; restart loader/plugin/none |
| | `reload_plugin` | `loader/reload_plugin` via `window.DeckyBackend`: re-imports backend and frontend |
| CEF (`cef.py`) | `cef_targets` | list CDP targets on `localhost:8080` |
| | `cef_evaluate` | `Runtime.evaluate` in any tab (default SharedJSContext) |
| | `cef_screenshot` | PNG of one CEF tab |
| | `toast` | Decky toast in the Steam UI |
| Screen (`screen.py`) | `screen_capture` | JPEG of the full gamescope output (PipeWire node) |
| | `stream_status` / `set_stream_settings` | MJPEG/audio stream state; change fps/quality/width/audio |
| Input (`input.py`) | `set_input_enabled` | turn remote input on/off (off by default, persisted) |
| | `input_key`, `input_text`, `input_mouse` | keyboard and mouse through gamescope libei (uinput fallback) |
| | `input_gamepad` | buttons/axes/hat/sequences on a uinput Xbox 360 pad routed through Steam Input |
| Controllers (`controllers.py`) | `list_controllers` | Steam Input's `ControllerStore` merged with evdev |
| | `add_virtual_controller` / `remove_virtual_controller` | plug/unplug persistent virtual pads |
| UI (`ui.py`) | `ui_routes` | official, plugin and patched routes, side-menu state, active plugin |
| | `ui_navigate` | navigate a path, back, QAM tab, main menu, open a Decky plugin panel, open an app page |

**Non-MCP surfaces.** HTTP (see `docs/api.md`): `/health`, `/viewer`, `/stream.mjpeg`, `/frame.jpg`,
`/stream/{stats,settings}`, `/audio` (PCM WebSocket), `/audio/stats`, `/input` (WebSocket) and
`/input/settings`, `/controllers` (+ `/virtual`, SSE `/events`), `/ui/routes`, `/ui/navigate`, `/pair/request*`,
`/pair/requests`, `/plugins`, `/plugins/install`, `/plugins/{dir}/reload`, `/loader/restart`,
`/logs/stream` (SSE), `/logs/tail`. **VS Code extension** (`extension/package.json`, 39 commands): device
management (add/edit/remove/switch, connect, re-pair, enter/copy token, change host), screen (open screen,
open viewer, snapshot to file, copy viewer URL), input and controllers (toggle input, add/remove/refresh
virtual controllers), UI (navigate, open plugin panel, back, Quick Access, close menus), dev loop (deploy,
deploy with full restart, toggle auto-deploy on change, install zip, reload plugin, restart loader, loader
logs, plugin logs, refresh plugins), JS eval, toast, and writing the MCP config for the workspace. **Browser
viewer** (`static/viewer.html`): live MJPEG with pause/fit/fullscreen/snapshot; stream settings (fps,
quality, width, audio); audio playback with local mute and volume; input toggle (keyboard, mouse,
browser-gamepad forwarding with a choice of target pad); a controllers popover with "add virtual".

## 1. Surveyed projects

| Project | Kind | Transport | Reaches the Deck via | Tools | Last activity | Licence |
|---|---|---|---|---|---|---|
| [mpsijben/steamdeck-mcp](https://github.com/mpsijben/steamdeck-mcp) | MCP on device (stdio; remote over `ssh deck@… python3 server.py`) | stdio | CDP `:8080` (SteamClient + stores), steamos-manager over `busctl --user`, `gamescopectl`, xdotool, uinput pad, sysfs, flatpak | 97 | 2026-10-19 | MIT |
| [qd313/decky-plugin-studio](https://github.com/qd313/decky-plugin-studio) | VS Code/Cursor extension + MCP on the dev machine | stdio | SSH/scp, CDP via an SSH tunnel, an ESP32 USB gamepad "bridge", systemd-logind inhibitor | 44 | 2026-11-02 | Apache-2.0 |
| [deucebucket/steamdeck_mcp](https://github.com/deucebucket/steamdeck_mcp) | MCP on device | stdio | sysfs/hwmon, steamos-manager, gamescope, uinput, Steam `steam://` | 38 | 2026-05-10 | MIT |
| [elliotttate/mcp-steamos-devkit](https://github.com/elliotttate/mcp-steamos-devkit) | MCP on dev machine (Valve Devkit Client wrapper; also Steam Frame/Android "Lepton") | stdio | mDNS devkit discovery, devkit HTTP, SSH, rsync, adb | 79 | 2026-07-07 | MIT |
| [rolandreads/bazzite-mcp](https://github.com/rolandreads/bazzite-mcp) | MCP on host (Bazzite desktop mode) | stdio (FastMCP) | local shell: ujust, rpm-ostree, systemd, KDE/Wayland tools, podman | 23 | 2026-03-05 | MIT |
| [RyanWReid/claude-deck](https://github.com/RyanWReid/claude-deck) | Decky plugin + on-device MCP for an assistant | stdio | CDP `:8080` | 16 | 2026-10-17 | MIT |
| [Garthnesss/ElfDeckAI](https://github.com/Garthnesss/ElfDeckAI) | MCP on device (or over SSH) | stdio | uinput keyboard/mouse/pad, `gamescopectl screenshot` | 22 (unverified) | 2026-10-28 | MIT |
| [TuxLux40/decky-claude](https://github.com/TuxLux40/decky-claude) | Decky plugin running Claude Code + on-device MCP | stdio | CDP `:8080`, `gamescopectl`, xdotool/ydotool | 8 | 2026-10-31 | MIT |
| [iannitram/decky-claude](https://github.com/iannitram/decky-claude) (fork) | same; adds tmux terminal/diagnose skeletons (`NotImplementedError`) | stdio | same | 8 (identical) | 2026-11-02 | MIT |
| [linuxkafe/deck-3dsdevkit](https://github.com/linuxkafe/deck-3dsdevkit) (was deck-devkitpro) | Decky plugin + MCP in a podman container (3DS toolchain) | stdio | local podman | 7 | 2026-10-22 | MIT |
| [SpysyWeeb/decky-claude-terminal](https://github.com/SpysyWeeb/decky-claude-terminal) | Decky plugin: Claude Code tmux terminal in QAM | n/a (no MCP) | tmux, whisper.cpp | 0 | 2026-10-29 | BSD-3-Clause |
| [Pimmeke1989/steamos-ha-decky](https://github.com/Pimmeke1989/steamos-ha-decky) | Home Assistant integration + Decky plugin | LAN HTTP + push | Decky backend API, Wake-on-LAN | sensors + 5 controls | 2026-09-14 | MIT |
| [Praeses0/steam-mcp](https://github.com/Praeses0/steam-mcp) | MCP on the machine running Steam | stdio | local VDF files, `steam://`, optional Web API key | 14 (66 actions) | 2026-03-23 | MIT |
| [Jackson-Brooks/steam-local-mcp](https://github.com/Jackson-Brooks/steam-local-mcp) | MCP, Windows Steam client | stdio | local files, `steam://` | 17 | 2026-07-21 | (unverified) |
| [Sarg338/steam-mcp](https://github.com/Sarg338/steam-mcp) | Web API MCP (official registry) | stdio | Steam Web API key | 41 | 2026-09-24 | NOASSERTION |
| [sharkusmanch/steam-mcp-server](https://github.com/sharkusmanch/steam-mcp-server) | Web API MCP | stdio | Web API key | 34 | 2026-10-28 | MIT |
| [TMHSDigital/steam-mcp](https://github.com/TMHSDigital/steam-mcp) | Web API + Steamworks publisher MCP | stdio | Web API / publisher key | 39 | 2026-10-25 | NOASSERTION |
| [Grinv/steam-games-mcp](https://github.com/Grinv/steam-games-mcp) | Store/Web API MCP (mostly keyless) | stdio | Store API, Web API | 29 | 2026-10-22 | MIT |
| [obrien-matthew/mcp-steam](https://github.com/obrien-matthew/mcp-steam), [chaosman42/steam-mcp](https://github.com/chaosman42/steam-mcp), [matheusslg/steam-mcp](https://github.com/matheusslg/steam-mcp), [algorhythmic/steam-mcp](https://github.com/algorhythmic/steam-mcp), [jimsantora/simple-steam-mcp](https://github.com/jimsantora/simple-steam-mcp), [dsp/mcp-server-steam](https://github.com/dsp/mcp-server-steam), [sandraschi/steam-mcp](https://github.com/sandraschi/steam-mcp) | Web API MCP | stdio | Web API key | 21 / 15 / ~19 / 10 / 7 / 2 / ~14 | 2025-02 to 2026-11 | mostly MIT |
| [nathanloehlein/ha-steam-parental](https://github.com/nathanloehlein/ha-steam-parental) | HA integration (Steam Families) | HTTPS | undocumented `IParentalService` | 3 services | 2026-10-02 | MIT |

Not agent tooling but adjacent: [glitchless-gg/glitchless-deck](https://github.com/glitchless-gg/glitchless-deck)
(CLI: send, launch and measure builds), [KevinTCoughlin/lazydeck](https://github.com/KevinTCoughlin/lazydeck)
(devkit TUI), [btd1337/claude-skill-decky-plugin-dev](https://github.com/btd1337/claude-skill-decky-plugin-dev)
(Claude skill, no tools), [jflessenkemper/easy-red-2-claude-plugin](https://github.com/jflessenkemper/easy-red-2-claude-plugin)
(drives one game under headless gamescope). Searches for "gamescope mcp", "decky mcp", "steamos mcp",
"steamcmd mcp" and Node-RED Steam Deck nodes found nothing else relevant. Smithery was not queried directly.
Hosted registry-only entries (`ai.trendsmcp/steam` and similar) were not opened.

## 2. Tool inventories

### 2.1 mpsijben/steamdeck-mcp: 97 tools

Defined in [`steamdeck_mcp/server.py`](https://github.com/mpsijben/steamdeck-mcp/blob/main/steamdeck_mcp/server.py)
(`_tool(...)`). It has three access levels (`readonly`, `standard` (default), `full`). Only `full` exposes the
input tools. Destructive tools require `confirm=true`. Mechanisms: `steam.py`/`cdp.py` (SteamClient over CDP,
including protobuf writes to `Settings.SetSetting` and `Perf.UpdateSettings`), `steamos_manager.py`
(`busctl --user`), `screen.py` (`gamescopectl screenshot` + xdotool), `gamepad.py` (uinput).

- **Setup/health:** `steam_integration_status`, `enable_steam_integration`, `api_health`
- **Device info:** `system_status`, `power_settings`, `audio_status`, `network_status`, `bluetooth_devices`,
  `top_processes`, `storage_locations`, `screen_timeouts`, `persistent_settings`, `system_settings`, `wifi_diagnostics`
- **Library and games:** `list_games`, `game_info`, `running_games`, `search_owned_games`, `achievements`,
  `workshop_items`, `game_notes`, `flatpak_apps`
- **Game lifecycle:** `launch_game`, `stop_game`, `install_game`, `uninstall_game`, `update_game`, `verify_game`,
  `move_game`, `add_shortcut`, `remove_shortcut`, `set_workshop_item`, `set_artwork`
- **Game config/compat:** `set_launch_options`, `set_game_option`, `set_game_branch`, `set_dlc`,
  `set_game_profile`, `list_compat_tools`, `list_proton_installs`, `list_global_compat_tools`, `set_compat_tool`,
  `set_global_compat_tool`, `check_ge_proton`, `install_ge_proton`, `remove_proton`
- **Performance/power:** `perf_status`, `measure_fps`, `set_tdp`, `set_gpu_clock`, `set_fps_limit`,
  `set_scaling`, `set_perf_overlay`, `set_brightness`, `set_charge_limit`, `set_power_option`,
  `set_screen_timeout`, `forget_persistent_settings`, `power_action`, `switch_mode`
- **Downloads/updates/storage:** `download_status`, `download_queue`, `set_downloads_paused`,
  `check_os_updates`, `os_update`, `cleanup_report`, `delete_orphans`, `trim_storage`
- **Capture:** `screenshot`, `screenshots`, `view_screenshot`, `delete_screenshots`, `recording_status`,
  `set_recording`, `save_clip`, `export_clip`, `delete_clip`
- **Input (`full`):** `press_key`, `press_button`, `move_stick`, `type_text`, `mouse_click`, `mouse_move`, `mouse_scroll`
- **System/network/misc:** `set_volume`, `bluetooth_connect`, `set_airplane_mode`, `set_steam_online`,
  `music_control`, `set_system_setting`, `install_flatpak`, `uninstall_flatpak`, `tv_switch_input`
- **Logs/cloud:** `find_game_logs`, `read_log`, `cloud_status`, `cloud_sync`

### 2.2 qd313/decky-plugin-studio: 44 tools

Defined in [`mcp-server/src/toolRegistry.ts`](https://github.com/qd313/decky-plugin-studio/blob/main/mcp-server/src/toolRegistry.ts),
with implementations in `mcp-server/src/deck/*.ts` and `tools/*.ts`. It runs on the dev machine and reaches the
Deck over SSH plus a CDP tunnel. Physical button presses go through an ESP32 board acting as a USB gamepad, and
a human-only killswitch re-arms automation.

- **Machines/session:** `deck_configure`, `deck_listMachines`, `deck_releaseMachine`, `deck_status`,
  `deck_getEnv`, `deck_checkReady`, `studio_doctor`
- **Automation safety:** `deck_stopAutomation`, `deck_automationStatus`
- **CDP tunnel/telemetry:** `deck_startTunnel`, `deck_stopTunnel`, `deck_probeIngest`, `deck_tailIngest` (debug events pushed from the plugin)
- **Capture:** `deck_captureScreenshot` (composited, QAM included), `deck_record` (video), `deck_installCaptureHelper`
- **Dev loop:** `plugin_detect`, `plugin_build`, `plugin_verifyZip`, `deck_deploy`, `deck_reloadPlugin`,
  `deck_openPlugin`, `deck_readPluginLog`, `plugin_diffRpc` (frontend `call()` sites vs `main.py` methods),
  `plugin_lintFocus` (static D-pad focus lint)
- **UI introspection:** `deck_readPage` (evaluate a question against the plugin's page), `deck_waitFor`
  (poll an expression until true), `deck_readFocus` (gamepad focus graph), `deck_assertFocusMove`, `deck_focusBigPicture`
- **Input (hardware pad):** `deck_pressButton`, `deck_pressChord`, `deck_walkTo`, `deck_runSequence`, `deck_sweep`
- **Games:** `deck_listGames`, `deck_launchGame`, `deck_exitGame` (by pressing buttons, read before every A)
- **Test hygiene:** `deck_saveCheck`, `deck_replayChecks`, `deck_holdAwake` (logind sleep inhibitor),
  `deck_restorePowerSettings`, `deck_snapshotSettings`, `deck_restoreSettings` (plugin settings/data dirs)

### 2.3 deucebucket/steamdeck_mcp: 38 tools

Defined in [`src/steamdeck_mcp/server.py`](https://github.com/deucebucket/steamdeck_mcp/blob/main/src/steamdeck_mcp/server.py) (`@mcp.tool`).

- **Power/perf:** `set_tdp_limit`, `set_tdp_limit_sysfs`, `cycle_tdp_recovery`, `set_gpu_clock`,
  `set_fan_mode`, `set_fan_pwm`, `set_charge_limit`
- **Display/gamescope:** `set_brightness`, `gamescope_set_fps_limit`, `gamescope_set_fsr`,
  `gamescope_set_output_brightness`, `mangohud_set_preset`
- **Audio/Bluetooth:** `set_volume`, `mute_audio`, `bluetooth_connect`, `bluetooth_disconnect`, `bluetooth_pair`
- **Gamepad:** `gamepad_init`, `gamepad_release`, `gamepad_tap_button`, `gamepad_hold_button`,
  `gamepad_release_button`, `gamepad_set_axis`, `gamepad_tap_sequence`
- **Apps/emulation:** `launch_game`, `emulator_launch`, `emulator_install_mod`, `emulator_list_mods`
- **Capture:** `capture_frame`, `capture_status`
- **Updates/firmware/storage:** `steamos_update_check`, `steamos_update_apply`, `firmware_check`,
  `firmware_refresh_metadata`, `firmware_apply`, `storage_path_usage`
- **Messaging:** `messaging_unread`, `messaging_send` (an inbox between agent and user, not Steam chat (unverified))

### 2.4 Category summaries for the rest

- **mcp-steamos-devkit (79):** device discovery/registration, title upload/run/delete, session and Steam
  client switching, `enable_cef_debugging`, `steam_rpc`, `run_remote_command` (shell), `journalctl_tail`,
  `coredump_list`, `gpu_trace`/`rgp_capture`/RenderDoc, `screenshot`, plus about 40 Steam Frame / Android / adb
  tools. Defined in [`src/mcp_steamos_devkit/server.py`](https://github.com/elliotttate/mcp-steamos-devkit/blob/main/src/mcp_steamos_devkit/server.py).
  This is the only project with GPU profiling and coredumps.
- **bazzite-mcp (23):** desktop-mode host admin: `ujust`, `packages`, `manage_service`, `manage_network`,
  `manage_firewall`, `manage_snapshots`, containers/VMs, `screenshot`, `send_input`, `manage_windows`,
  accessibility `interact`/`set_text`, `display_config`, `quick_setting`, `gsettings`, and `gaming`
  (library/reports/settings). Registered from `tools/*/__init__.py` in
  [`src/bazzite_mcp/server.py`](https://github.com/rolandreads/bazzite-mcp/blob/main/src/bazzite_mcp/server.py).
  It has a guardrails/audit layer. Nothing is gamescope-specific.
- **claude-deck (16):** `steam_js` (arbitrary JS), `sign_in`, `screenshot`, `backup_saves`/`list_backups`/
  `restore_backup`, `list_games`, `game_info`, `set_launch_options`, `list_compat_tools`, `set_compat_tool`,
  `launch_game`, `stop_game`, `running_games`, `get_performance`, `set_performance`. `TOOLS` dict in
  [`steam_mcp.py`](https://github.com/RyanWReid/claude-deck/blob/master/steam_mcp.py).
- **decky-claude (8):** `steam_ui_targets`, `steam_ui_eval`, `steam_snippet`, `session_context`, `screenshot`,
  `send_key`, `type_text`, `mouse_move_click`. In [`mcp_server.py`](https://github.com/TuxLux40/decky-claude/blob/main/mcp_server.py).
  The fork's MCP tools are byte-identical.
- **ElfDeckAI (~22):** keyboard (`key_tap/down/up/release`), pad (`pad_press/down/up/stick/trigger/center/reset`),
  mouse (9 tools) via uinput, plus `screenshot` and `wait`. In [`elfdeckai_mcp.py`](https://github.com/Garthnesss/ElfDeckAI/blob/main/elfdeckai_mcp.py).
- **deck-3dsdevkit (7):** `compile_3ds`, `clean`, `toolchain_status`, `list_libraries`, `list_groups`,
  `debug_headless`, `debug_status` ([`mcp/server.py`](https://github.com/linuxkafe/deck-3dsdevkit/blob/master/mcp/server.py)).
- **Local Steam client servers (Praeses0, steam-local-mcp):** library/install state, launch/install/uninstall/
  verify/move via `steam://`, launch options, Proton/ProtonDB, shader cache and storage reports, non-Steam shortcuts.
- **Steam Web API servers (Sarg338, sharkusmanch, Grinv, obrien, chaosman42, matheusslg, algorhythmic …):**
  profile, friends, owned games/playtime, achievements and schemas, store search/details/prices/specials,
  reviews, news, player counts, wishlist, inventory/market. Several have `deck_compatibility` lookups
  (Sarg338 `steam_get_deck_compatibility`, TMHSDigital `getDeckCompatibility`, Grinv's Verified/Playable filter).
  TMHSDigital also has publisher writes (`setAchievement`, `grantInventoryItem`, `uploadWorkshopItem`, …;
  off by default, `dry_run`). sharkusmanch has trade-offer readers.
- **steamos-ha-decky:** sensors (game mode, current game, CPU/GPU temp and usage, fan, battery, SSD temp),
  a game started/stopped event, toast, sleep/shutdown/restart, Wake-on-LAN.

## 3. Gap analysis

Legend: **Us** = Decky Toolkit has a dedicated tool. **Them** = another project has it and we do not. **None** = nobody
has it. **Via** = mechanism: JS = SteamClient/stores over our existing CDP; SM = steamos-manager D-Bus;
SD = systemd/logind; DL = Decky loader routes (`utilities/*`, `loader/*`); FS = files. "(eval)" means it is
already reachable today through `cef_evaluate`, but without a typed tool. Effort: S < 1 day, M 1-3 days, L > 3 days.

| Category | Status | Who has it | Via | Effort |
|---|---|---|---|---|
| Device info (OS, Decky, plugins) | Us (`decky_status`) | all | FS | — |
| Battery, temps, power state | Them | mpsijben `system_status`, HA-decky, deucebucket | JS `RegisterForBatteryStateChanges`, `GetSystemInfo`; hwmon FS | S |
| Suspend/restart/shutdown, game/desktop mode switch | Them | mpsijben `power_action`/`switch_mode`, HA-decky | JS `SuspendPC`/`RestartPC`; SM `SessionManagement1` | S (needs a confirm gate) |
| Keep awake during a test run | Them | plugin-studio `deck_holdAwake` | SD `systemd-inhibit --what=sleep:idle` | S |
| TDP / GPU clock / CPU governor / fan / charge limit | Them | mpsijben, deucebucket, claude-deck | SM `TdpLimit1`, `GpuPerformanceLevel1`, `CpuScaling1`, `FanControl1`, `BatteryChargeLimit1` plus a Steam setting sync (JS `Settings.SetSetting`, fields 22001/22002, 22011/22012) | M |
| Frame limit, FSR/scaling, perf overlay level | Them | mpsijben `set_fps_limit`/`set_scaling`/`set_perf_overlay`, deucebucket (gamescope) | JS `Perf.UpdateSettings` protobuf; read via `Perf.RegisterForStateChanges` | M |
| FPS measurement | Them | mpsijben `measure_fps` | gamescope/MangoHud stats (unverified approach) | M |
| Brightness | Them | mpsijben, deucebucket | JS `Display.SetBrightness` (no getter; use `RegisterForBrightnessChanges`) | S |
| Resolution/refresh, HDR | None (refresh is only implied by the fps limit) | — | JS `DisplayManager.SetMode` protobuf, `SetGamescopeInternalResolution` (unverified) | L |
| Audio volume/output device | Them | mpsijben, deucebucket | JS `Audio.GetDevices`/`SetDeviceVolume`/`SetDefaultDeviceOverride` | S |
| Audio monitoring (hear the device) | **Us only** (`/audio`, `rms_db`) | — | PipeWire | — |
| Wi-Fi/airplane/Bluetooth | Them | mpsijben, deucebucket | JS `Network.*`, `SetAirplaneMode`, `Bluetooth.*`; SM `WifiPowerManagement1` | M |
| App list / running apps | Them | mpsijben, plugin-studio, claude-deck, Praeses0 | JS `appStore.allApps`, `SteamUIStore.RunningApps` (eval) | S |
| Launch / terminate app | Them | mpsijben, claude-deck, plugin-studio, deucebucket | JS `Apps.RunGame(id,"",-1,100)`, `Apps.TerminateApp(id,false)` (eval) | S |
| Install/uninstall/verify/move | Them | mpsijben, Praeses0, steam-local-mcp | JS `Installs.OpenInstallWizard`/`OpenUninstallWizard`, `Apps.VerifyApp`, `InstallFolder.MoveInstallFolderForApp` | M |
| Launch options, Proton/compat tool, DLC, branch | Them | mpsijben, claude-deck, Praeses0 | JS `SetAppLaunchOptions`, `SpecifyCompatTool`, `GetAvailableCompatTools`, `SetDLCEnabled`, `JoinAppContentBeta` | S-M |
| Downloads queue, pause/resume | Them | mpsijben | JS `downloadsStore.LocalDownloadOverview`, `Downloads.EnableAllDownloads`, `QueueAppUpdate` | S |
| OS / firmware updates | Them | mpsijben `os_update`, deucebucket | JS `Updates.CheckForUpdates`/`ApplyUpdates`; SM `UpdateBios1`/`UpdateDock1` | M (risky) |
| Decky loader self-update | None | — | DL `updater/check_for_updates`, `do_update` | S |
| Screenshot of full display | Us (`screen_capture`, `cef_screenshot`) | mpsijben, plugin-studio, ElfDeckAI, decky-claude | PipeWire / `gamescopectl` | — |
| Live video stream | **Us only** (MJPEG viewer) | — | PipeWire | — |
| Record a clip to file | Them | plugin-studio `deck_record`, mpsijben `save_clip` (Steam Game Recording) | our PipeWire pipeline to an MP4/WebM file | M |
| Steam screenshot library | Them | mpsijben `screenshots`/`view_screenshot` | JS `Screenshots.GetAllLocalScreenshots` | S |
| Keyboard/mouse input | Us (libei, exact absolute) | mpsijben (xdotool), ElfDeckAI/deucebucket (uinput), decky-claude | — | — |
| Gamepad through Steam Input, multiple named pads | Us (also others with one pad; plugin-studio uses a hardware pad) | mpsijben, deucebucket, ElfDeckAI | — | — |
| Controller list (Steam Input view) | **Us only** | — | — | — |
| Steam UI navigation / QAM / route table | **Us only** (others press buttons) | plugin-studio walks focus with the pad | — | — |
| Read UI state: focus ring, DOM query, wait-for | Them | plugin-studio `deck_readFocus`/`deck_readPage`/`deck_waitFor` | JS over CDP (`.gpfocus`, `document.querySelector` in the QAM tab) | S-M |
| Frontend console / uncaught exceptions | None (plugin-studio needs plugin-side ingest code) | — | CDP `Runtime.enable` → `consoleAPICalled`/`exceptionThrown` and `Log.entryAdded` on SharedJSContext | M |
| Plugin install / reload / restart loader | Us | plugin-studio (deploy over SSH, reload) | DL | — |
| Plugin enable/disable/uninstall | None | — | DL `utilities/enable_plugin`, `disable_plugin`, `uninstall_plugin` | S |
| Decky store search/install | None | — | `GET plugins.deckbrew.xyz/plugins`; DL `utilities/install_plugin` (shows a confirm dialog) | S-M |
| Call a plugin backend method directly | None | — | DL `loader/call_plugin_method` via `window.DeckyBackend` | S |
| Frontend/backend RPC parity check | Them | plugin-studio `plugin_diffRpc` (static, dev-machine side) | runtime variant: compare frontend callables to `loader/get_plugins` method list | M |
| Plugin settings snapshot/restore | Them | plugin-studio | FS `~/homebrew/settings/<name>`, `~/homebrew/data/<name>` | S |
| Logs: loader + plugin | Us (tools + SSE streams) | plugin-studio, mpsijben (game logs) | — | — |
| Game/Proton logs, coredumps, journal of other units | Them | mpsijben `find_game_logs`, devkit `coredump_list`/`journalctl_tail` | FS `steamapps/compatdata`, `PROTON_LOG`, `coredumpctl`, journal | S |
| File read/write | Us (root) | devkit (rsync), plugin-studio (scp) | — | — |
| Directory listing / stat / delete | None as a tool (we have read/write only) | devkit via shell | FS | S |
| Shell exec | Them | devkit `run_remote_command`, bazzite-mcp (`ujust`, services), plugin-studio via SSH | subprocess | S (high risk) |
| Friends / social / Steam chat | Them (Web API, read-only) | Sarg338, sharkusmanch, Grinv, … | Web API key; JS `friendStore` (eval, unverified) | M |
| Online/offline status | Them | mpsijben `set_steam_online` | JS `User.GoOnline`/`GoOffline` | S |
| Cloud saves: status / sync / conflict | Them | mpsijben `cloud_status`/`cloud_sync`; claude-deck backups | JS `Apps.GetCloudPendingRemoteOperations` (untyped), `Cloud.RetryAppSync`, `ResolveAppSyncConflict` | S-M |
| Notifications: send a toast | Us (`toast`) | HA-decky | — | — |
| Notifications: read Steam's notification list | None | — | JS notification store (unverified) | M |
| Achievements | Them | mpsijben, Web API servers | JS `Apps.GetMyAchievementsForApp` | S |
| Deck compatibility rating | Them (Web API) | Sarg338, TMHSDigital, Grinv | Store API | S |
| GPU profiling / traces | Them | devkit (`gpu_trace`, `rgp_capture`) | RGP/RenderDoc tooling | L |

## 4. Recommendations for Decky Toolkit

### 4.1 Top 10 for plugin development

1. **`cef_console` (frontend console + exceptions).** CDP `Runtime.enable` on SharedJSContext (and the QAM/
   Big Picture tabs), buffering `Runtime.consoleAPICalled`, `Runtime.exceptionThrown` and `Log.entryAdded`. Add
   a `/logs/stream?source=frontend` SSE twin. This is the biggest blind spot in the plugin dev loop: today a
   frontend crash shows up only as a blank panel. Nobody has it without plugin-side instrumentation (plugin-studio's
   ingest needs code in the plugin). Effort: M.
2. **`ui_query` / `ui_wait_for` / `ui_focus`.** Evaluate a selector or expression against the visible
   document (QAM tab or Big Picture window), poll until it is true with a timeout, and report the `.gpfocus`
   element with its ancestors. This replaces guessed sleeps after `ui_navigate`/`reload_plugin` and lets an agent
   assert "my panel mounted" or "focus moved to X". It matches plugin-studio's most-used tools, without SSH or
   hardware. Effort: S-M.
3. **`call_plugin_method` (backend callable test).** `loader/call_plugin_method` through `window.DeckyBackend`
   returns the result or the traceback. Agents could unit-test a plugin's Python API on the device without
   building UI. Add `list_plugin_methods` to pair it with a runtime RPC parity check (frontend `callable()` names
   vs backend). Effort: S.
4. **Plugin lifecycle completion: `set_plugin_enabled`, `uninstall_plugin`, `store_search`,
   `store_install`.** Use DL `utilities/enable_plugin`/`disable_plugin`/`uninstall_plugin`, the
   `plugins.deckbrew.xyz/plugins` API and `utilities/install_plugin` (it puts up an on-device confirm, which is a
   good safety property). Needed to test conflicts with other plugins and clean reinstalls. Effort: S-M.
5. **`plugin_settings_snapshot` / `restore`.** Copy `~/homebrew/settings/<dir>` and `~/homebrew/data/<dir>` to
   a named snapshot on the device, then restore. Makes test runs repeatable and pairs with `install_plugin`.
   Effort: S.
6. **`app_list` / `app_launch` / `app_terminate` / `running_apps`.** Use `appStore`, `SteamUIStore.RunningApps`,
   `Apps.RunGame`, `Apps.TerminateApp` and `GameSessions.RegisterForAppLifetimeNotifications`. Many plugins act
   in-game (overlays, per-game profiles, game-page patches), so an agent must be able to put a game in the
   foreground and take it away. Already possible through `cef_evaluate`, but brittle without a typed tool. Effort: S.
7. **`screen_record` (clip to file).** Tee the existing PipeWire pipeline into a WebM/MP4 for N seconds and
   return the path, or the bytes over HTTP. Animated UI bugs and focus transitions do not show in stills.
   plugin-studio and mpsijben both have this. Effort: M.
8. **`device_state` + `hold_awake`.** One read with battery/AC, temps, the perf state
   (`Perf.RegisterForStateChanges`: TDP, fps limit, overlay level), the display mode and the focused app. Add a
   `systemd-inhibit` lease so a long agent run is not lost to sleep. Plugins that touch power/perf (the most
   common Decky category) need the before/after state. Effort: S.
9. **`perf_set` (TDP, GPU clock, fps limit, perf overlay, scaling).** Use the steamos-manager session-bus
   interfaces (`TdpLimit1`, `GpuPerformanceLevel1`), then sync Steam's own setting so Game Mode does not revert
   it, as mpsijben does. Use `Perf.UpdateSettings` for fps limit, overlay and scaling. This lets developers of
   perf/TDP plugins reproduce conditions and check that their plugin's writes stick. Our backend is root, so it
   must target `/run/user/<uid>/bus` (unverified on device). Effort: M.
10. **`fs_list` / `fs_stat` / `fs_delete` + game/Proton log finder.** Cheap, fills the gap between
    `read_file` and shell. Agents currently guess paths. Add `find_game_logs` (compatdata, `steam-<appid>.log`)
    and a `journal` tool for arbitrary units (`steam`, `gamescope-session`, `inputplumber`), because plugin
    bugs often surface there. Effort: S.

### 4.2 Nice for general device control

Brightness and volume/output device (S); Wi-Fi/Bluetooth/airplane mode (M); suspend/restart/game↔desktop
switch behind a confirm (S); launch options, Proton version, DLC, branch (S-M); install/uninstall/verify/move
(M); downloads queue and pause (S); cloud sync status and retry (S-M); Steam screenshot library (S);
achievements (S); online/offline (S); Decky self-update check (S); OS update check, apply behind a confirm (M);
display mode/refresh/HDR (L, protobuf and unverified); a Web API bridge for friends and Deck compatibility
(M, needs a user-supplied key; better left to the existing Web API servers).

### 4.3 What only Decky Toolkit has

- MCP **on the device over Streamable HTTP**, with **on-device pairing approval**. Every other on-device
  server is stdio and needs SSH plus a password or key.
- **Live MJPEG video plus PCM audio** in a browser viewer and in VS Code, with device-wide stream settings.
- **libei keyboard/mouse** into gamescope (exact absolute positioning in the focused window). Others use
  xdotool (needs the right `DISPLAY`) or relative uinput.
- **Multiple named virtual pads** confirmed by Steam Input, and a **controller list from Steam Input's own
  store** merged with evdev. A remote browser gamepad can be forwarded to a chosen pad.
- **Steam UI route table and navigation** (official, plugin and patched routes; open a Decky plugin panel
  directly; QAM tabs). Others reach screens only by pressing buttons.
- **Atomic plugin install with a safe loader restart** (transient systemd unit swap, which avoids the orphaned
  backend) and `reload_plugin` through Decky's own loader that refreshes both halves.
- **SSE log streams** for the loader journal and plugin logs, plus HTTP equivalents of every tool for
  non-MCP clients.

## 5. Security and safety notes

- **Already high-power in Decky Toolkit:** `cef_evaluate` is full Steam-client control: purchases through the
  store page, account and Steam Guard flows, uninstalls, Family settings. `write_file`/`read_file` run as
  root, so they can read `~/.steam` config and `ssh` keys, and anything written is root-owned. `install_plugin`
  is code execution as root (Decky plugins with the `root` flag). Input tools can do anything a user can. These
  are acceptable for a paired dev tool, but:
  - Consider a read-only/standard/full **access level per token**, as mpsijben does. A pairing could grant
    "observe" (screen, logs, routes, status) without eval/write/install/input.
  - `read_file` should refuse or flag `~/.local/share/Steam/config/*.vdf`, `loginusers.vdf` and
    `ssfn*`/`config.vdf` (session tokens). Exfiltrating these moves a Steam login to another machine.
  - Log every `cef_evaluate`, `write_file` and `install_plugin` call with the client name, and show a toast on
    the first one per session, as is done for input.
- **New tools in §4 that need a confirm argument and/or an on-device prompt:** power and mode switching,
  uninstall/move, OS/firmware/BIOS/dock updates (SM `UpdateBios1`/`UpdateDock1` can brick if interrupted),
  `Storage1.FormatDevice`, `FactoryReset1`, `System.FactoryReset`, `delete`-type file tools, and charge-limit
  or fan writes (`FanControl1` = OS mode with a bad curve is a thermal risk; deucebucket's `set_fan_pwm`
  exposes raw PWM).
- **Never add without an explicit design review:** shell exec (devkit `run_remote_command`, bazzite-mcp
  services). With `write_file` + root it adds little capability but removes all auditability. Also: store
  purchase/checkout, wallet, trade offers, account and Family/parental changes (ha-steam-parental uses an
  undocumented API), sign-in/credential entry (claude-deck's `sign_in` (unverified)), Steam Guard.
- **Store installs:** prefer DL `utilities/install_plugin`, which raises Decky's own confirm dialog on the
  device, over silent zip installs from URLs. Verify the store-provided hash.
- **D-Bus writes in Game Mode:** steamos-manager writes can be overwritten by Steam's stored settings
  (mpsijben's finding). A tool that reports success must re-read after Steam has had a chance to re-apply.
- **Supply chain of the surveyed projects:** ElfDeckAI installs with `curl | sh`. Playtide-studios/steam-mcp
  reportedly self-updates and talks to a raw-IP backend (unverified). Do not vendor code from these without
  review. mpsijben (MIT) is the best reference for protobuf field numbers (`steamdeck_mcp/steam.py` lines 10-18,
  590-640). Those numbers come from Steam's UI code and can change with any Steam update.

## 6. Unverified items

- steamos-manager's session bus reached from a root process (`DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus`
  or `busctl --machine=<user>@.host --user`), and which interfaces Bazzite exports. Bazzite ships
  `steamos-manager-powerstation`, and TDP on non-Valve hardware goes via `org.shadowblip.PowerStation`.
- The meaning of `TerminateApp`'s second argument, what `ClearProton` does, and any direct refresh-rate or HDR
  setter. There is no `TakeScreenshot` in the typings.
- ElfDeckAI's exact tool count; licence of steam-local-mcp; Smithery listings; deucebucket's `messaging_*` semantics.
- mpsijben's confirm gate on every destructive tool. Checked for `switch_mode`, `power_action`,
  `uninstall_game` and `delete_clip` only.
- Read-only status of sharkusmanch's trade tools and TMHSDigital's `createLobby`.
