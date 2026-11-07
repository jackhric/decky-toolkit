# Decky Toolkit for VS Code

Companion extension for the [Decky Toolkit](https://github.com/jackhric/decky-toolkit#readme) Decky Loader plugin. It talks to the plugin's
HTTP server on the device (port 8765; any machine running Decky Loader: Steam Deck, SteamOS,
Bazzite, …) and gives you, inside VS Code or VSCodium:

- a **Decky** sidebar (Activity Bar icon) that shows your device; connect to it and its actions
  (grouped by Screen, Plugin, Loader, Steam and MCP), plugins, controllers and a small live preview
  appear, so you never need the command palette,
- a **Games** view: every installed title with its save data, install folder, Proton prefix, Steam
  Cloud folder, shader cache and Proton log, one click from opening a save file in the editor,
- a remote file system (`decky://<host>/<path>`): device folders open in the Explorer and files
  open and save in place,
- controller management: every controller Steam Input sees, virtual Xbox 360 pads you add or
  remove with one click, and a choice of which pad your local gamepad drives,
- Steam UI navigation (any page, a game's details, a plugin's panel, Back, Quick Access),
- a live view of the device's display (30 fps MJPEG) in an editor tab,
- one-click deploy of the Decky plugin open in your workspace: it is detected automatically, built
  only when its sources changed, and reloaded on its own (no loader restart),
  optionally on every change; plus install of any plugin zip,
- live loader and plugin logs in output channels,
- a JavaScript console for the Steam UI (`SharedJSContext`) and toasts on the device,
- a generated `.mcp.json` so Claude Code and other MCP clients in the workspace can use the device.

The Decky Toolkit plugin must already be installed and enabled on the device. For now the extension
works with one device at a time: adding another replaces the saved one.

## Getting started

1. **Click the Decky icon** (the Steam Deck logo) in the Activity Bar. The **Devices** view shows
   your saved device. The first time, it contains the device from the `decky-toolkit.host` setting; use
   the **+** in the view title to add one (see [Adding a device](#adding-a-device)).
2. **Click the device** (or its plug icon). If it is not paired yet, pairing starts at once; see
   [Pairing](#pairing). If it is paired, it connects.
3. **Work.** When it is connected, the **Actions**, **Plugins**, **Games**, **Controllers** and **Preview** views appear below
   the list, with the device's name in their title bars. The screen panel opens automatically after
   the first connect of a session (setting `decky-toolkit.openScreenOnConnect`). If your workspace is a
   Decky plugin, you are offered to deploy it; afterwards use the `$(rocket) Deploy <name>` button in
   the status bar, <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>D</kbd> (<kbd>Cmd</kbd>+<kbd>Alt</kbd>+<kbd>D</kbd>
   on macOS) or **Plugin → Deploy** in the Actions view. See [Deploy](#deploy).
4. **Disconnect** with the icon on the device row. The pairing is kept, so the next connect needs no
   approval.

The status bar shows `$(vm-connect) <name>` while connected and `$(vm) Decky: not connected`
otherwise. Click it for the device's actions: connect or disconnect, open the screen, rename or forget
it (add a device when none is saved). When the
device stops answering it turns into `$(debug-disconnect) <name>: connection lost` on a warning
background (`$(key) <name>: pairing rejected` on an error background when the device no longer accepts
this editor), and a click reconnects; see [Losing the connection](#losing-the-connection).

## Sidebar

The extension talks to the device through its versioned client API; device paths in this README such as
`/stream/stats` are relative to `/api/v1` (only `/health` and `/mcp` sit at the top level). It never uses the MCP tools,
which are meant for agents.

Before you connect, the sidebar shows only **Devices**. After you connect, **Actions**, **Plugins**,
**Games**, **Controllers** and **Preview** appear below it, all for the connected device. They stay
there for the rest of the window, also after a disconnect, so the layout never jumps; while the
device is not connected they are empty and say why (see [Losing the connection](#losing-the-connection)).

### Devices

The view holds one device at a time, and its row is also the connection state. If the name is the host, the
row shows the host once and `vX.Y.Z · state` as the description; otherwise the description is
`host:port · vX.Y.Z · state`.

| State | Icon | Description | Click | Inline icons |
| --- | --- | --- | --- | --- |
| not paired | `key` | `v0.2.1 · not paired` | connect (pairs first) | Connect, `…` |
| paired, not connected | `vm` | `v0.2.1 · paired` | connect | Connect, `…` |
| connecting / pairing | spinner | `connecting…` / `waiting for approval · code 4821` | none | none |
| connected | `vm-connect` (green) | `v0.2.1 · connected` | none | Disconnect, `…` |
| unreachable | `warning` (yellow) | `unreachable` | connect (retries) | Connect, `…` |
| connected, pairing rejected | `key` (red) | `v0.2.1 · pairing rejected` | reconnect (pairs again) | Disconnect, `…` |

The version is the plugin version from the device's public `/health`, so it shows before pairing too;
it is left out until the device has answered once.

The `…` icon and the right-click menu hold the rest: **Rename…** (the name only) and **Forget device**
(also deletes its pairing). There is no manual pairing: no Re-pair and no address
editing. A device that stops accepting this editor is paired again by connecting to it, which asks for
approval on the device; a device that moved to another address is forgotten and added again (or found
by [Discovery](#discovery)). Connect and disconnect live here and in the status bar item's menu.

The view title has **Add device** (+), **Search network** (`$(search)`, see [Discovery](#discovery))
and **Refresh** (also checks which devices answer). With no saved device and none found on the network,
a welcome view takes its place: the flat Decky Toolkit mark, an **Add a device** button, the line *The
device needs Decky Loader and the Decky Toolkit plugin installed* (the plugin name links to this repo) and
**How pairing works**, which opens the *Connect a Decky device* walkthrough (install the plugin, add the
device, approve it, open the screen). The welcome view and the Devices tree switch on the
`decky-toolkit.hasDevices` context key, and the welcome view searches the network too while it is shown.

#### Discovery

Below the saved device, an **On this network** group lists Decky Toolkit devices on the local network
that are not saved, the way Moonlight finds its hosts. Each row shows the device's host name with
`ip · vX.Y.Z` (`ip:port` when the port is not 8765) and the `vm` icon. Click it, or its plug icon,
to save the device and connect; an unpaired device goes straight into [pairing](#pairing). When a device is already saved, a modal asks
**Replace <name>?** first, because the saved device and its pairing are forgotten. The group's
last row is **Add a device by address…**. While a search runs the group shows a spinner and
`searching…`; afterwards `N found` or `none found`.

How devices are found:

- **mDNS / DNS-SD.** The plugin advertises `_decky-toolkit._tcp` through the device's avahi-daemon
  (instance name = host name, TXT `api`, `version`, `id`). The extension asks for it on each of this
  machine's network interfaces.
- **Local subnet probe.** At the same time it asks `GET /health` on port 8765 of every address in this
  machine's own subnets (only /22 or smaller, at most 1024 addresses, 128 at a time, 1.2 s timeout).
  This also finds older plugin builds that do not advertise, and networks that filter multicast.
  A /24 takes about 2.5 s.

Only answers whose `/health` identifies Decky Toolkit are listed. The saved
device (same address or host name, and port) and a second address of the same device (`device_id`)
are left out. Loopback, link-local, container, VM and VPN interfaces (`docker*`, `br-*`, `virbr*`,
`veth*`, `tun*`, `wg*`, `tailscale*`, …) are skipped.

Discovery covers the local network only: mDNS does not cross routers, and the probe never leaves
this machine's subnets. Add a device on another network by its address (**Add device**). A search
runs when the Devices view opens (at most once a minute) and when you click **Search network**;
nothing scans in the background. Turn it off with `decky-toolkit.discovery.enabled`.

### Actions

Everything you can do with the connected device, in collapsible groups. Every leaf runs with one
click. Screen, Plugin and Loader start expanded, Steam and MCP collapsed; VS Code remembers what
you expand or collapse.

- **Screen** (description: fps and Mbit/s from `/stream/stats`, polled every 5 s only while the
  view is visible)
  - **Open screen panel**: the live screen in an editor tab.
  - **Snapshot to file**: fetches `/stream/frame` and saves it (default name `screen-<timestamp>.jpg`).
- **Plugin** (description: `<name> v<version>` of the detected plugin; the tooltip names its folder
  and the directory it deploys to)
  - **Deploy** (fast, see [Deploy](#deploy)), **Deploy (full restart)**, **Reload backend**, **Show
    plugin logs** and **Auto-deploy on change: On/Off** for the plugin in the workspace (a picker
    asks if there are several). Without one the group says *no plugin.json in workspace*, the
    actions show *needs a plugin folder*, and clicking one tells you to open your plugin folder.
    **New plugin…** is always there (see [New plugin](#new-plugin)).
- **Loader**
  - **Restart loader**, **Show loader logs**, **Install plugin zip…** (pick any `.zip`).
- **Steam**
  - **Navigate to…**: a picker built from `GET /ui/routes` with the current page as its
    placeholder. Sections **Official** (Library, Settings, …; the current page is marked),
    **Plugins** (pages plugins registered) and **Menus** (main menu, Quick Access and each Quick
    Access tab). An entry with a placeholder such as `/library/app/{appid}` asks for the value
    first (digits only for ids). The pick is sent as `POST /ui/navigate`.
  - **Open save data…**: picks a game and opens its save folder in the Explorer (see
    [Games](#games)).
  - **Open plugin panel…**: picks an installed plugin (`/plugins`) and opens its Quick Access
    panel (`{action: "plugin"}`). Also in the right-click menu of a row in the Plugins view.
  - **Back**, **Quick Access**, **Close menus**: one click each.
  - **Evaluate JS in Steam UI** (`POST /cef/evaluate`), **Toast on device** (`POST /ui/toast`).

  The status bar briefly shows the page the Steam UI ended up on.
- **MCP**
  - **Write MCP config for this workspace** (runs the `decky-toolkit` CLI), **Copy MCP URL** (a local
    `http://127.0.0.1:<port>/<secret>/mcp` that stays the same across restarts; the port is
    `decky-toolkit.mcpPort`).

The view title has **Open screen** and **Refresh**.

### Plugins

Lists the device's plugins (`GET /plugins`) as
`Name  version · dir`; hover for flags, `api_version` and `has_backend`. The inline icons reload a
plugin's backend (`POST /plugins/{dir}/reload`) or open its log. The title bar has **Install
plugin zip…** (pick a `.zip`, upload to `/plugins/install?restart=loader`, wait for the loader) and
Refresh.

### Games

Every installed title on the device (`GET /apps`: Steam games and non-Steam shortcuts), most recently
played first. The view starts collapsed; libraries are large, so the title bar has **Find game…**
(`$(search)`): a picker over all titles that fuzzy-matches the name (and runtime), shows the app id,
when it was last played and its size, and reveals and expands the game you pick. The title bar
also has **Open device path…** and Refresh.

| Row | Description |
| --- | --- |
| a Proton title | `Proton 11` (`Proton Experimental`, or the tool's name for GE-Proton and others) |
| a native title on the Steam Linux Runtime | `Linux runtime` |
| a title without a compatibility tool (most shortcuts) | `native` |
| a running title | green play icon, `· running` |

The inline icons launch the game (`POST /apps/{appid}/launch`) or, while it runs, terminate it (`.../terminate`,
after a modal *Terminate X?* confirmation, since unsaved progress is lost), and open its save data.
Expanding a game loads `/apps/{appid}/dirs` and `/apps/{appid}/saves` and shows:

- **Save data** (expanded): one row per save location, best first: the folders holding the files
  Steam Cloud tracks (cloud icon), then folders Steam Auto-Cloud marked and folders found by name.
  Paths are shortened (`AppData/Local/<Game>/Saved/SaveGames` inside a prefix, `~/.local/share/...`
  in the home), the description says how many saves and how recent the newest is. Expanding a
  location lists the folder (folders first; save files get a save icon, every file shows its size
  and age). **Click a file to open it in an editor tab**; saving writes it back to the device.
- **Game data** (native titles): the matching `~/.local/share`, `~/.config` folders.
- **Install folder**, **Steam Cloud (userdata)** (`userdata/<account>/<appid>`) and **Shader
  cache**, each a browsable folder.
- **Proton prefix** (Proton titles): shortcuts to `drive_c/users/steamuser` `AppData/Local`,
  `AppData/Roaming`, `AppData/LocalLow`, `Documents`, `Saved Games` (whichever exist; the
  description names the game's own folder in it) and the whole `drive_c`.
- **Proton log** (**Launch log** for native titles): opens `~/steam-<appid>.log` (written when the
  game runs with the launch option `PROTON_LOG=1 %command%`, otherwise a hint saying so) plus every
  line of Steam's `logs/` that mentions the app id, in an editor tab.

Right-click a folder or file for **Open in Explorer** (also the inline icon on folders) and **Copy
path**; right-click a game for **Open save data**, **Launch**/**Terminate**, **Show Proton log**
and **Copy path** (the install folder). **Show Proton log** reads `/apps/{appid}/proton-log`.

#### Jump into a game's saves

1. Open the **Games** view and click **Find game…** (or run **Decky: Open save data…** from the
   palette or **Actions → Steam**).
2. Type part of the name, for example `vvv`.
3. **Open save data…** adds the best save folder as a workspace folder named like
   `VVVVVV saves (10.0.70.18)` (`decky://10.0.70.18/home/jackh/.local/share/VVVVVV/saves`) and shows
   the Explorer. Or expand the game in the Games view and click a save file to open it directly.

### Remote files (`decky://`)

The extension registers a file system for the scheme `decky`: `decky://<host>/<absolute path>`
(`<host>:<port>` when the port is not 8765). It serves any saved, paired device, also when it is
not the connected one; the pairing comes from the identity file.

- **Read**: `stat` and directory listings use `GET /fs` (a stat lists the parent with an exact
  glob), files `GET /fs/read` (up to 64 MiB). Symlinks are resolved to file or folder.
- **Write**: saving uses `PUT /fs/write`; new folders `POST /fs/mkdir`, rename/move
  `POST /fs/rename`, delete `DELETE /fs?...&confirm=1` (VS Code asks before deleting). The device
  only writes inside a game's install folder, a Proton prefix (`compatdata/<appid>/...`),
  `userdata/<account>/<appid>/...`, the Decky Toolkit data folder, and `~/.local/share` / `~/.config`
  folders named after an installed game; deleting follows `fs_delete`'s rules (not the
  `~/.local/share` game folders). New files and folders get the owner of their parent, so the game
  can still write its saves.
- **Errors**: a refused path (outside those folders, or Steam's login files such as
  `config/loginusers.vdf`) shows as *permission denied* with the device's reason; a device that is
  not reachable, not paired or not saved shows as *unavailable* with the reason.
- **Open device path…** (Games title bar, palette) asks for a path (`/…` or `~/…`): folders open in
  the Explorer, files in the editor.
- Changes on the device are not watched; use the Explorer's Refresh.

Adding a workspace folder to a window without one reopens the window as a workspace (VS Code
restarts extensions); the extension activates again on `onFileSystem:decky` and reconnects.

### Controllers

Every controller on the device, one row each (`GET /controllers`), as Steam Input sees it:

| Row | Icon | Description |
| --- | --- | --- |
| physical controller | `game` | `physical · Steam Input: steamdeck (slot 0)` |
| virtual pad | `game` (blue), name + `(virtual)` unless the name says so | `virtual · Steam Input: xbox360 (slot 1)` |
| not picked up yet | as above | `physical · not seen by Steam Input` |

Hover a row for the USB id, the device node, the Steam Input name and, for virtual pads, the id
and whether it is the pad the device created on its own for forwarded input ("Auto").

- **Add virtual controller** (`+` in the title, or the button in the empty view): asks for an
  optional name (Enter takes `Virtual pad N`) and sends `POST /controllers/virtual`. On success:
  *Virtual controller added and recognised by Steam Input*. The device allows 4 pads you add; when
  they are all used, or when Steam Input does not pick the new pad up, the device's message is
  shown as it is.
- **Remove** (trash icon on a virtual row, or the right-click menu): `DELETE /controllers/virtual/{id}`,
  no confirmation. From the palette it asks which pad.
- **Live**: the list follows the device's `controllers` events (`/events`), so a controller plugged in
  on the device appears at once. After a dropped connection the reconnect brings the current list.
- With no controllers the view says *No controllers seen by Steam Input.* with an **Add virtual
  controller** button.

### Preview

Fetches one `/stream/frame` every 1.5 s while the view is visible (well under 1 Mbit/s, instead of the
~40 Mbit/s stream), scaled to the sidebar width. Click **Open full screen view** or the title icon
for the screen panel.

## New plugin

**Decky: New plugin…** (also in the Actions view, the empty Explorer and the walkthrough) creates a plugin from
[decky-plugin-template](https://github.com/SteamDeckHomebrew/decky-plugin-template) in six steps: name, author
(default `git config user.name`), what it has (frontend only, plus a Python backend, or plus an MCP tool through
`decky-toolkit/tools`), build tool (the template's rollup, or vite), template version (the commit this release was
tested with, or the latest) and parent folder. It downloads the template, renames it, drops the template's ssh deploy
tasks (`.vscode/`) and Docker example (`backend/`), then runs `pnpm install` and `pnpm run build` (the `pnpm` on your
PATH, else a pinned one through `npx`). The new `plugin.json` has no `debug` or `_root` flag.

Then it asks whether to open the folder, and with a paired device **Open and Deploy**: the folder opens (in this window
when none is open, else in a new one), and the window that opens it deploys the plugin (the first install restarts
Decky Loader) and turns on auto-deploy with live sync running, so the next save reloads it in place.

## Deploy

The extension looks for Decky plugins in the workspace: every folder with a `plugin.json`, in a
workspace folder or up to two levels below it (not in `node_modules`). It reads the name, author,
flags and `api_version` from `plugin.json` and the version from `package.json`, and installs to
`~/homebrew/plugins/<folder name>` (setting `decky-toolkit.pluginDirName` overrides the name). A plugin the
device already has under the same `plugin.json` name is updated in its own directory instead. Plugins
are expected to follow the [decky-plugin-template](https://github.com/SteamDeckHomebrew/decky-plugin-template)
layout. Edits to `plugin.json` or `package.json` are picked up at once.

The first time a plugin is found while a device is connected you get *Decky plugin detected:
<name>. Deploy to <device>?* with **Deploy** and **Not now** (once per window). While a device is
connected, the status bar shows `$(rocket) Deploy <name>` (`$(sync~spin)` while a deploy runs).

**One click.** Deploy runs these steps and reports *Deployed <name> in 0.6 s*:

1. **Build, only if needed.** With `decky-toolkit.deploy.build` = `auto` (default), `pnpm run build` runs
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
`decky-toolkit.deploy.onChange` setting) keeps the device in step with your plugin folder. While it is on,
the extension runs the plugin's `watch` script (`decky-toolkit.deploy.watchBuild`), with its output in the
Decky Toolkit output channel. The first change to `dist/`, `py_modules/`, `assets/`, `defaults/`, `main.py`
or the manifests deploys the plugin. After that, each change is pushed file by file and the plugin reloads
in place, usually within 100 ms of the build:

- a bundle change re-imports only the frontend; the backend keeps running;
- a Python change restarts the backend;
- a `plugin.json` or `package.json` change deploys again.

You stay where you were: the plugin's Quick Access panel, its own page, the selected settings tab and the
focused control. Errors the plugin logs while loading appear in the output channel with positions in your
sources. Reloads report in the status bar.

## Remote input

The screen panel can drive the device with your keyboard, mouse and a gamepad. Remote input is **off
by default** and is a device-wide switch: it is the same flag as the **Allow remote input** toggle
in the device's Decky Toolkit panel.

- **Turn it on or off** with the keyboard icon in the screen panel's tab bar (`$(keyboard)` while
  off, `$(record-keys)` while on), or run **Decky: Toggle remote input** from the command palette. The extension sends
  `PUT /input/settings`; the panel itself never calls the device for this. While input is on the
  status bar shows `$(keyboard)` after the device's name. If the device cannot inject input, turning
  it on shows a warning with the reason.
- **Mouse and keyboard**: click the picture to capture input (a focus outline shows it). Mouse
  moves, clicks and the wheel land on the matching spot of the device screen, and keys are sent by
  physical position (`KeyboardEvent.code`), so VS Code keybindings do not fire while the picture
  has focus. Click outside the picture, switch tabs or leave the window to give the keyboard back;
  every held key and button is released.
- **Gamepad**: a controller connected to this computer is forwarded about 60 times a second while
  the panel has focus (the panel briefly shows *Gamepad connected*). It appears on the device as an
  Xbox 360 pad. Whether the Gamepad API works inside a webview depends on the VS Code build.
- **Gamepad goes to** (in the stream settings) picks which pad on the device your gamepad drives:
  **Auto** (the pad the device creates on its own, the default) or one of the virtual pads from the
  [Controllers](#controllers) view; **New virtual pad…** adds one and selects it. The choice goes
  into the `pad` field of every gamepad message; switching sends the old pad a neutral state first.
  It falls back to Auto when that pad is removed.

The panel's WebSocket (`/input`) goes through the same loopback proxy as the stream.

## Screen panel controls

The panel is only the picture. Its controls are native icons in the editor tab bar, shown while the
panel is the active editor of its group:

| Icon | Command | What it does |
| --- | --- | --- |
| `$(keyboard)` / `$(record-keys)` | Turn on / off remote input | Device-wide, see [Remote input](#remote-input) |
| `$(unmute)` / `$(mute)` | Mute / Unmute | Sound on this computer only; shown while the device streams audio |
| `$(settings-gear)` | Stream settings… | QuickPick, see below |
| `$(debug-pause)` / `$(play)` | Pause / Resume | Freezes the picture; the stream stays connected |
| `$(device-camera)` | Snapshot to file | Saves the current `/stream/frame` with a Save dialog |
| `$(plug)` | Reconnect | Only while not connected, in place of input, settings and snapshot; see [Losing the connection](#losing-the-connection) |

**Stream settings…** lists:

- *Stream · every client*: **Frame rate** (15/24/30/60 fps), **JPEG quality** (50-90), **Size**
  (native, 1600, 1280, 960, 640 px wide) and **Audio** on/off. These are device-wide
  (`/stream/settings`, the same values the `stream_settings` tool changes); the extension sends
  the `PUT`, and the panel shows *Applying stream settings…* until the first frame of the restarted
  stream arrives. Changes made elsewhere arrive at once as `stream_settings` events. A device without the
  route offers only the local entries.
- *This computer*: **Volume** (100-10 %; picking one unmutes) and **Gamepad goes to** (see
  [Remote input](#remote-input)). Mute and volume are remembered across panels and sessions.

**Sound** is on by default: the panel plays what the device is playing (`/audio`, raw 48 kHz stereo
PCM, about 1.5 Mbit/s, through the same loopback proxy) with an AudioWorklet that keeps about 120 ms
buffered and drops back when it falls 300 ms behind. Until VS Code allows sound (it may need a click
in the panel first) the panel shows *Click the picture to enable audio*. The audio socket closes
while the panel is hidden, like the video stream.

The screen is only available here: the device serves no browser viewer.

## Pairing

Pairing starts when you connect to a device you have not paired with, or one that no longer accepts
this editor. Approving on the device is the only way in.

1. **Reachability.** The extension calls `GET /health`. If the device does not answer, you
   get one error: *Can't reach <name> at host:port. Is the device on and Decky Toolkit enabled?* with
   **Retry**. Nothing else happens.
2. **Request.** The extension files `POST /pair/request` with the name *VS Code on <hostname>*
   (*VSCodium* or *Cursor* in those editors) and gets a 4-digit code.
3. **Waiting, with no time limit.** One progress notification: *Decky Toolkit: Waiting for approval on
   <name> · code 4821. On the device: Quick Access → Decky Toolkit → Approve.* with **Cancel**; the device
   row says *waiting for approval · code 4821*. The device shows a toast *VS Code on <hostname> wants
   to pair · code 4821*, and its Decky Toolkit panel switches to an *Approve pairing request?* prompt with
   **Approve** and **Deny**. The extension long-polls `GET /pair/request/{id}?wait=25`. Network errors (the device
   sleeping, a loader restart) only show *Lost contact with <name>, retrying…*; it keeps trying until
   you cancel. If the device forgot the request (plugin restarted), it files a new one and shows the
   new code. **Cancel** withdraws the request (`DELETE /pair/request/{id}`).
4. **Allowed.** The pairing is stored, the device becomes connected (the screen panel opens per
   `decky-toolkit.openScreenOnConnect`) and you see *Paired with <name>* with **Open screen** and
   **Deploy plugin**.
5. **Denied.** *Pairing denied on <name>* with **Try again**.

A device whose plugin predates pairing requests gets *Update Decky Toolkit on <name> to pair with it*.
Other failures (for example too many pending requests) offer **Try again**.

### Adding a device

**Add device** asks for the IP address or hostname (`host:port` also works), then for an optional
name (press Enter to use the host). The port is 8765. A picker then offers **Connect to <name>**,
**Change port (8765)…** and **Not now**. Connect goes straight into the steps above. When a device is
already saved, **Add device** first asks **Replace <name>?** (*Its pairing is deleted. This editor
connects to one device at a time.*); **Replace** forgets the saved device and its pairing, **Cancel**
keeps it.

## Connection model

- **One state object.** `Connection` holds the saved device (stored as a list of one) and its pairing, the
  session (the connected device) and a state per device: `unpaired`, `disconnected` (paired),
  `connecting`, `pairing`, `connected` or `unreachable`. The views, status bar, screen panel and
  preview subscribe to its events.
- **Events.** While connected, the extension holds the device's event stream (`GET /events`): input
  settings, controllers, stream settings and the plugin list arrive as they change, with no polling. The
  stream ending (or 40 s without its 15 s heartbeat) means the device dropped: `/health` is checked at once
  and then every 2 s while it fails; the stream reconnects with backoff, and its `hello` brings everything
  up to date. Only the fps/Mbit/s readout (`/stream/stats`, every 5 s while the Actions view or screen
  panel is open) and the sidebar preview still poll.
- **Health.** While the stream is down, `/health` is checked every 15 s. If it fails, the device shows as
  unreachable but stays the connected device, with its pairing; when it answers again it is connected
  again. Commands such as Deploy need a connected device; if there is none they offer to connect.
- **Reconnect.** The connected device is remembered. After a window reload the extension reconnects to
  it silently if it answers and the device still accepts it; if it does not answer yet, it reconnects as
  soon as it does (a saved device that does not answer is probed every 15 s).

### Losing the connection

Nothing closes when the connection goes. Every surface stays where it is, says what happened, and
fills again by itself when the device answers. The state (context key `decky-toolkit.link`) is one of:

| State | When | Recovers |
| --- | --- | --- |
| `connection lost` | the event stream or the screen stream drops and an immediate `/health` check fails (device asleep, network gone, Decky Loader restarting) | by itself: `/health` is retried every 2 s while lost, and the event stream reconnects |
| `pairing rejected` | a request answers 401 (the event stream's reconnect after the device forgot this editor, or the stats poll) | **Reconnect**, which pairs again (approve on the device) |
| `disconnected` | you clicked Disconnect (or forgot / replaced the device) | **Reconnect** |
| `connecting…` | a connect or pairing is running | by itself |

- **Actions, Plugins, Games, Controllers**: stay visible but empty, with a welcome message for the
  state (*Lost connection to the device. …* with **Reconnect now**, *The device no longer accepts
  this editor …* with **Reconnect**, *Disconnected from the device.* with **Reconnect**). The view title
  description says `<name> · connection lost` (or `pairing rejected`, `disconnected`).
- **Preview**: stops fetching, hides its button and shows the same explanation as the screen panel.
- **Screen panel**: stays open. The tab title becomes `Screen: <name> (connection lost)` (or
  `(pairing rejected)`, `(disconnected)`), the last frame stays dimmed behind a message such as *Lost
  connection to <name>. Reconnecting as soon as it answers again…*, the stream, input and audio
  sockets close, and the tab bar swaps remote input, stream settings and snapshot for a
  `$(plug)` **Reconnect** action (mute and pause stay). On recovery the stream, input and audio come
  back and the title loses its suffix.
- **Log channels** (loader and plugin logs): one line, e.g. `[decky-toolkit] Lost connection to
  <name>. Output resumes when it is connected again.`, then `[decky-toolkit] Connected to <name>
  again.` when it resumes; no error line per retry. After a Disconnect the log stream stops too.
- **`decky://` files and folders**: editors stay open. While the device does not answer (or is not
  paired, or no longer accepts this editor) their tab and Explorer entry get a `!` badge in the warning colour
  with a tooltip saying why saving fails; it clears when the device answers. A Disconnect does not
  mark them, since `decky://` keeps working with the stored pairing.

## Commands

All of these are also in the command palette under the `Decky:` category.

| Command | What it does |
| --- | --- |
| Decky: Connect | Connects to a device; pairs first when it is not paired or no longer accepted |
| Decky: Disconnect | Ends the session; keeps the pairing |
| Decky: Reconnect | Connects to the device of the last session again (pairs again when it was rejected) |
| Decky: Add device… / Rename device / Forget device | Add a device (replacing the saved one), rename it, or forget it and its pairing |
| Decky: Search network | Look for unsaved Decky Toolkit devices on the local network ([Discovery](#discovery)) |
| Decky: Open screen | Live screen panel with sound; remote input, mute, stream settings, pause and snapshot as tab bar icons |
| Decky: Snapshot to file | Saves the current `/stream/frame` with a Save dialog |
| Decky: New plugin… | Create a plugin from decky-plugin-template, build it, open it and optionally deploy it ([New plugin](#new-plugin)) |
| Decky: Deploy plugin | Build if needed, zip, `POST /plugins/install`, reload just this plugin and confirm it (<kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>D</kbd>) |
| Decky: Deploy plugin (full restart) | Same, but restarts Decky Loader and waits for `/health` |
| Decky: Toggle auto-deploy on change | Flips `decky-toolkit.deploy.onChange` for the workspace |
| Decky: Toggle remote input | Turns remote keyboard, mouse and gamepad input on or off for the whole device (`PUT /input/settings`) |
| Decky: Add virtual controller / Remove virtual controller / Refresh controllers | Manage virtual Xbox 360 pads on the device (`/controllers/virtual`) |
| Decky: Navigate Steam UI to… | Picker of official pages, plugin pages and menus from `/ui/routes`; asks for template values such as the app id |
| Decky: Open plugin panel… | Opens an installed plugin's Quick Access panel |
| Decky: Steam UI: Back / Quick Access / Close menus | `POST /ui/navigate` with `back`, `quick_access` or `close_menus` |
| Decky: Find game… | Picker over the installed titles (fuzzy match); reveals the game in the Games view |
| Decky: Open save data… | Picks a game and adds its best save folder to the Explorer (`decky://`) |
| Decky: Open device path… | Opens a device folder in the Explorer or a device file in the editor |
| Decky: Launch game / Terminate game | `app_launch`; `app_terminate` after a confirmation |
| Decky: Show Proton log | `logs_read` with `source: proton` for a game, in an editor tab |
| Decky: Refresh games | Reloads the Games view |
| Decky: Install plugin zip… | Uploads a plugin zip from disk to `/plugins/install?restart=loader` |
| Decky: Restart loader | `POST /loader/restart` |
| Decky: Reload plugin | `POST /plugins/{dir}/reload` (backend mode) for one plugin |
| Decky: Show loader logs | Streams `journalctl -u plugin_loader` via `/logs/stream` |
| Decky: Show plugin logs | Streams a plugin's log from `~/homebrew/logs/<dir>/` |
| Decky: Evaluate JS in Steam UI | Runs an expression with the `cef_evaluate` tool; result in an info message or the "Decky Toolkit Console" output |
| Decky: Toast on device | Shows a Decky toast |
| Decky: Write MCP config for this workspace | Adds `mcpServers.decky` to `.mcp.json` in the first workspace folder: `npx -y decky-toolkit mcp`, the CLI, which uses this machine's pairing |
| Decky: Copy MCP URL | Copies the local MCP URL (`http://127.0.0.1:<port>/<secret>/mcp`), which works while VS Code is open; the MCP config above is preferred |
| Decky: Refresh / Refresh plugins | Re-reads `/health`, checks which devices answer, reloads the plugin list |

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `decky-toolkit.openScreenOnConnect` | `true` | Open the screen panel after the first successful connect of a session |
| `decky-toolkit.host` | (empty) | Device IP or hostname. When set, seeds the first saved device; used when the device list is empty |
| `decky-toolkit.port` | `8765` | Decky Toolkit server port (same rules as `host`) |
| `decky-toolkit.mcpPort` | `8766` | Local port MCP clients connect to; the next free port is used when another window holds it. Takes effect after a window reload |
| `decky-toolkit.pluginDirName` | (empty) | Target dir under `~/homebrew/plugins` for a first install; empty means the plugin folder's name. A plugin the device already has under the same `plugin.json` name is updated in its own dir |
| `decky-toolkit.deploy.build` | `auto` | `auto`: build only when `src/` is newer than `dist/index.js`; `always`; `never` |
| `decky-toolkit.deploy.onChange` | `false` | Keep the device in step: deploy on the first change, then push changed files and reload the plugin in place |
| `decky-toolkit.deploy.watchBuild` | `true` | While auto-deploy is on, run the plugin's `watch` script in the background |
| `decky-toolkit.discovery.enabled` | `true` | List unsaved Decky Toolkit devices on the local network under **On this network** (see [Discovery](#discovery)) |

The saved device lives in VS Code's global state (`decky-toolkit.devices`), so all windows share it.
The pairing is kept in `~/.config/decky-toolkit/identity.json` (`%APPDATA%\decky-toolkit\identity.json` on
Windows), one device per machine, and shared with the upcoming CLI.

## How it works

- **Credentials.** The pairing lives in the identity file. Webviews never see it: the extension runs
  a loopback proxy (`127.0.0.1`, stable port, secret path prefix kept in global state) that
  strips browser `Origin`/`Cookie` headers before forwarding to the device. WebSocket upgrades
  (`/input`, `/audio`) are forwarded the same way. The screen panel and the
  preview only know the proxy URL, and their CSP allows only that origin (plus its `ws:` form for
  the screen panel) and `blob:` (images, and the screen panel's inline AudioWorklet module, which
  Chromium checks against `script-src`). MCP clients use the same proxy under
  `/<secret>/mcp` (**Copy MCP URL**); the extension refreshes the port in a `.mcp.json` entry that
  holds that URL. **Write MCP config** writes the `decky-toolkit` CLI instead, which needs no open editor.
- **Theme.** The screen panel and preview use only VS Code theme colours (`--vscode-*` variables);
  only the video area itself is black.
- **Deploy** zips the staged files (see [Deploy](#deploy)) under a single `<dirname>/` folder with
  a built-in zip writer and uploads the zip. It confirms a fast reload from `/logs/tail` (the
  loader journal and the plugin's log) and `/plugins`. Build and deploy output goes to the
  "Decky" output channel.
- **API version.** `/health` lists the client API versions the device serves (`api`). A device without `v1`
  gets one warning per window asking you to update the Decky Toolkit plugin (Decky → Install Plugin from URL);
  nothing falls back to older routes, and deploying refuses such a device too.

## Development

```sh
cd extension
pnpm install
pnpm run build        # esbuild → dist/extension.js
pnpm run typecheck    # tsc --noEmit
npx @vscode/vsce package --no-dependencies   # → decky-toolkit-<version>.vsix
```

Run it in the Extension Development Host: run `pnpm run build`, open the `extension/` folder in VS
Code and press <kbd>F5</kbd> (launch config "Run Decky Toolkit extension"), then open your Decky plugin
folder in the new window. Or from a shell:

```sh
pnpm run build
code --extensionDevelopmentPath="$PWD" /path/to/your/decky-plugin
```

(`codium` works the same way.) Use `pnpm run watch` to rebuild on save, then run
"Developer: Reload Window" in the development host.

Install the packaged build with `code --install-extension decky-toolkit-<version>.vsix`.

### Smoke test (no device)

`scripts/smoke.mjs` loads the bundled extension against a stub `vscode` module and a fake device
(`scripts/smoke/harness.mjs`), then runs the checks in `scripts/smoke/<area>.mjs` in order:

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
`DELETE`, the "Update Decky Toolkit" path for an older device, the reachability error with Retry, the connection going unreachable and back (views kept but
empty with their welcome text, view descriptions, status bar, screen panel title and `link` message,
preview state, one log line each way, the `decky://` decoration, everything back on recovery), a
Disconnect and Reconnect, a rejected pairing mid-session and re-paired, `media/screen.js` stopping and
restarting stream, input and audio on the link state, Add device, snapshot, Copy MCP URL,
and the remote input toggle (title action and its icon, palette command, status bar
indicator, unavailable and unsupported devices), and the screen panel's controls: which tab bar
actions show with which icons for each state, mute and pause flipping their icon, the stream
settings QuickPick (`PUT` of one field, *Applying* message, volume unmuting, audio off hiding the
mute action, a 404 leaving only the local entries), and
`media/screen.js` run in a minimal DOM (audio socket and hint, `/input` socket and its 4003
handling). For controllers it checks the Controllers view rows (empty, physical and virtual,
404, error), live `controllers` events, add (default name, success text) and remove,
the 409 and Steam Input refusals shown as-is, the resync from `hello` after a dropped stream; the device events
(no `/health`, input or controller polling while the stream is up, input settings and the plugin list following
events, reconnects after `shutdown`, a silent stream and a drop, the outdated-plugin warning once); the
**Gamepad goes to** pick (**New virtual pad…**, fallback to Auto when the pad is removed, none on a
404) and, in `media/screen.js`, the `pad` field with a neutral state on switch; the Navigate to… picker
(sections, current page, template prompt), Open plugin panel, Back / Quick Access / Close menus,
a 400 and a 404; the Games view (a Proton title with saves and prefix shortcuts, a native title, a
shortcut whose saves fail, a 404 device, errors), the Find game picker, Open save data adding a
`decky://` workspace folder, launch, terminate with its confirmation, the Proton log tab and Open
device path; the `decky:` file system against a fake `/fs*` server (stat, listings, symlinks,
write/read round trip, mkdir, rename, delete with `confirm=1`, refused and sensitive paths as
`NoPermissions`, unreachable / unpaired / unknown devices as `Unavailable`).

### Deploy check (device)

`scripts/deploy-check.mjs` deploys a throwaway plugin built from the template through the same
code the extension uses and checks on the device that both halves changed:

```sh
DECKY_IDENTITY_FILE=~/deck-identity.json node scripts/deploy-check.mjs /path/to/decky-toolkit-test [host] [port]
```

The plugin must be named `Decky Toolkit Test`, export `VERSION` from `src/version.ts` and
`py_modules/testver/__init__.py`, set `window.__deckyToolkitTestVersion = VERSION` in its frontend and
have a `version` method. The script rewrites those per round: first install, fast deploy with and
without the `debug` flag, a deploy with nothing to build and one full restart (skipped while a
`/stream` viewer is connected, unless `IGNORE_VIEWERS=1`). Each round checks the bundle's version via `cef_evaluate`,
the backend's via `loader/call_plugin_method`, `/plugins`, the number of `Loaded` lines and that
exactly one backend process runs. At the end Decky uninstalls the plugin (no loader restart).

### Headless integration check

`scripts/dev-check.mjs` exercises the proxy, client and zip code against a live device without VS
Code:

```sh
DECKY_IDENTITY_FILE=~/deck-identity.json node scripts/dev-check.mjs [host] [port]
```

It checks `/health`, `/stream` (at least two thirds of the device's fps cap for 5 s),
`/stream/stats` and `/stream/frame` through the proxy, `/plugins` and `/stream/frame` through the client, runs `media/screen.js` in a minimal DOM against the
proxy and compares its fps readout with `/stream/stats` (within 10 %), calls MCP `tools/list`
through the client, opens a WebSocket to `/input` through the proxy and expects close code 4003
(input must be off on the Deck; the check never turns it on), opens `/audio` through the proxy and
expects the format frame and at least 10 PCM chunks within 1 s (audio must be on; the check never
changes it), reads `/controllers` and `/ui/routes`, waits for the `hello` of `/events` (read-only), checks that the old top-level
paths and the routes v1 dropped answer 404/405 and `/mcp` `GET`/`DELETE` 405, validates a staged zip with `unzip -t`,
and prints `INFO` lines (never failures) for `/fs?path=/home/jackh/.local/share/VVVVVV`,
`/apps/70300/saves` and a read-only `/fs/read` of the best VVVVVV save. The
stream checks need a screen that changes: gamescope sends no frames while the screen is static.
