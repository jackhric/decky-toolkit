# Input injection research (2026-11-04)

Findings of a research pass on sending keyboard, mouse and gamepad input to gamescope/Steam from the Decky Toolkit backend. Proof-of-concept modules: `input/uinput.py` (stdlib uinput) and `input/test_ei.py` (libei over ctypes).

I tested everything on the device. The best route is **not** uinput for keyboard and mouse. gamescope runs its own input server (libei), and Python can drive it through `ctypes` as root: it gives exact 1:1 absolute positioning, relative motion, buttons, wheel and keys. Use uinput only for the gamepad, where Steam picks the virtual pad up as a real controller.

## Device tests (Bazzite, kernel 7.2.9, gamescope 3.16.31-ogc2, test devices destroyed afterwards)

I made no key presses, button presses or touches. The only side effects were pointer moves of a few pixels, each reversed, plus one test pad being connected and removed. I checked the pointer position with `xdotool getmouselocation`.

| Test | Result |
|---|---|
| `/dev/uinput` | `crw-rw----+ root root`, plus an ACL for jackh (udev `uaccess` from `60-steam-input.rules`). Root opens it fine. |
| uinput relative mouse | Created `event9`. gamescope opened it within 1.5 s, through logind (TakeDevice, since gamescope owns seat0 session 36). The plugin running outside the session doesn't matter. A +5,+5 move put the pointer at `965,545`, and -5,-5 brought it back to `960,540`. |
| uinput absolute pointer (ABS_X/Y + BTN_LEFT, with and without INPUT_PROP_POINTER) | The device is opened, but **the pointer never moves**. |
| uinput touchscreen (ABS_MT_* + BTN_TOUCH + INPUT_PROP_DIRECT) | gamescope opens it and libinput reports `Capabilities: touch`. I did not send touches, because that is a click. |
| uinput keyboard (key codes 1–248) | gamescope opens it and libinput reports `Capabilities: keyboard`. I pressed no keys. |
| uinput Xbox 360 pad (045e:028e, version 0x114, bus USB) | Steam opened the evdev node itself; no hidraw is needed (this box has no `/dev/hidraw*` at all). Steam's `controller.txt` shows "Local Device Found… Xbox 360 Controller… opened for index 1" and the standard SDL mapping for 45e/28e. Steam created **one** extra virtual pad, `Microsoft X-Box 360 pad 1` (28de:11ff), and did not wrap its own pad again, so there is no loop. |
| InputPlumber | Logs "is virtual, skipping" for our devices, so it never grabs them. |
| libei via `ctypes` as root on `/run/user/1000/gamescope-0-ei` | Connected and got the device "Gamescope Virtual Input" with absolute pointer support. Absolute moves to (965,545), (300,200) and (960,540) landed exactly. |
| XTest with xdotool | XTest on `:1` moved the pointer of the focused window on `:0`, so gamescope routes XTest into its normal input path. Root is refused ("Authorization required"; access is limited to `SI:localuser:jackh`), so it has to run as uid 1000. |
| CDP | The Big Picture tab reports a viewport of `1353x761` at `devicePixelRatio 1.42`. CDP coordinates are therefore in CSS pixels: `x = nx * innerWidth`, not 1920. |

One correction to the brief: Steam runs on `DISPLAY=:0`, and the pointer for the Steam UI moved on `:0`, so `:0` is not the game display.

## Why, from gamescope's source (tag 3.16.23 and the OpenGamingCollective fork)

- **Mouse input:** `wlserver_new_input` subscribes pointer devices only to `motion`, `button`, `axis` and `frame`. There is no `motion_absolute` handler, and tablet devices fall through to `default: break`. That is why the absolute uinput pointer did nothing.
- **No pointer acceleration:** relative motion uses `unaccel_dx` times `--mouse-sensitivity` (default 1), so one count is one pixel.
- **Touch:** the touch point is mapped to the output size, then through the focused window's offset and scale, so it maps correctly even into a scaled game. What a touch *does* depends on the touch mode, which Steam can change at runtime (`STEAM_TOUCH_CLICK_MODE` atom).
  - The default mode here is `4` (passthrough). Xwayland runs with `-noTouchPointerEmulation`, so most games, which don't handle XI2 touch, ignore it.
  - `--touch-gestures` is a fork patch: in passthrough, a drag that starts within 5% of the width (96 px) from the left or right edge opens the Steam menu or the Quick Access Menu.
  - Touch is a poor fit for click-at-pixel.
- **libei:** gamescope runs a libei server on `$XDG_RUNTIME_DIR/<wl_display>-ei` and sets `LIBEI_SOCKET` for Xwayland (`src/InputEmulation.cpp`, `wlserver.cpp:2096`). It offers relative and absolute pointer, buttons, scroll and keyboard. Absolute moves call `wlserver_mousewarp(x, y)`.
  - **Caveat:** those coordinates are in the focused window's own pixels, clamped to its size. In the Steam UI that is 1920x1080, so 1:1. A game rendering at 1280x800 and upscaled needs `x * window_width`, so you have to look up the focused window size (for example `xdotool getwindowfocus getwindowgeometry` as uid 1000).
  - Each libei connection logs a harmless `gamescope_ei: Unhandled libei event!`, so keep one connection open.
  - A warp alone doesn't show the cursor (it is marked synthetic); a click or button press does.
- **Keyboard:** keys go through gamescope's keyboard handler (us/pc105 here). Volume and power keys are always sent to Steam, never to the game.

## The uinput structs and ioctls (x86_64, checked against `<linux/uinput.h>` with gcc)

| Item | Value |
|---|---|
| `UI_DEV_CREATE` / `UI_DEV_DESTROY` | `0x5501` / `0x5502` |
| `UI_DEV_SETUP` | `0x405c5503` (92-byte struct) |
| `UI_ABS_SETUP` | `0x401c5504` (28-byte struct) |
| `UI_SET_EVBIT` / `KEYBIT` / `RELBIT` / `ABSBIT` | `0x40045564` / `65` / `66` / `67` |
| `UI_SET_PROPBIT` | `0x4004556e` |
| `UI_GET_SYSNAME(64)` | `0x8040552c` |
| `input_event` | `struct.Struct("@qqHHi")`, 24 bytes (timeval, type, code, value) |
| `uinput_setup` | `"@HHHH80sI"`: bustype, vendor, product, version, name[80], ff_effects_max |
| `uinput_abs_setup` | `"@H2x6i"`: code, padding, then value/min/max/fuzz/flat/resolution |

The working module (about 100 lines, stdlib only, with a `Device(name, keys=, rels=, abs=, props=, ...)` class and `emit()`/`close()`) is kept as `docs/research/input/uinput.py` (originally written in a temporary research scratchpad under `/tmp`). The libei proof of concept is `test_ei.py` in the same folder. It needs only `libei.so.1` and about 18 function bindings: `ei_new_sender`, `ei_setup_backend_socket`, then `ei_seat_bind_capabilities` on SEAT_ADDED, keep the device on DEVICE_RESUMED, then `ei_device_start_emulating` and `ei_device_pointer_motion_absolute` / `ei_device_button_button` / `ei_device_keyboard_key` / `ei_device_frame`.

**Gamepad layout** (it matches the SDL mapping Steam logged):
- **Buttons:** BTN_A/B/X/Y (0x130, 0x131, 0x133, 0x134), TL/TR (0x136/0x137), SELECT/START/MODE (0x13a–0x13c), THUMBL/THUMBR (0x13d/0x13e).
- **Sticks:** ABS_X/Y/RX/RY from -32768 to 32767 (fuzz 16, flat 128).
- **Triggers:** ABS_Z/RZ from 0 to 255.
- **D-pad:** ABS_HAT0X/Y from -1 to 1.

## What exists on each image

| | Bazzite | SteamOS 3.8.14 (package list) |
|---|---|---|
| `libei.so.1` | 1.6.0 (gamescope links `libeis.so.1`) | 1.4.1 |
| xdotool | yes | yes |
| ydotool | 1.0.4, but `ydotool.service` is disabled | absent |
| python-evdev | n/a | 1.9.0, but built for system Python 3.13, so unusable from Decky's 3.14 |
| inputplumber | 0.82 | 0.77.4 |

## Verdict per case

| Case | Use | Fallback |
|---|---|---|
| Keyboard, relative mouse, click-at-pixel, wheel (Steam UI and games) | **libei through ctypes** (verified as root) | uinput keyboard and relative mouse. To aim a click: a large negative move pins the cursor at 0,0, then move +x,+y. Only safe outside games that lock the pointer. |
| Gamepad | **uinput X360 pad** (verified) | none needed |
| Games with pointer lock | relative motion through libei or uinput (both also send relative-pointer events) | — |
| Steam UI text with non-ASCII characters | CDP `Input.insertText` on the Big Picture tab | — |
| CDP mouse and keys generally | Steam UI only. It skips gamescope, ignores focus, and can't reach the Quick Access Menu or other overlay windows. Diagnostics only. | — |
| xdotool | Works, but needs a subprocess as uid 1000 and adds nothing over libei | — |
| ydotool | Not on SteamOS, and only wraps uinput | — |
| Remote Play | Not viable: closed, encrypted protocol that needs a paired Steam client. No public server side to inject into. | — |

**Not verified:**
- Whether SteamOS 3.8's gamescope 3.16.23 is built with libei server support. The source at that tag has it and libei ships in the image, but the plugin should check at runtime that the socket exists and fall back to uinput.
- libei behaviour inside a running game (no game was running), including the scaling for low-resolution games.
- Whether Steam hides the raw virtual pad from games.

## Design proposal

**Backend** (`py_modules/decky_toolkit/input/`):
- `uinput.py`: the module above.
- `ei.py`: the ctypes libei sender. Reconnect when the socket reappears after a gamescope restart. Read `XDG_RUNTIME_DIR` (`/run/user/<uid of the gamescope-wl process>`) and the display name `gamescope-0` from the process.
- `service.py`: one input service.
  - Tracks which keys and buttons are held, and releases them all when a client disconnects, input is disabled, or the plugin unloads.
  - Creates the pad only on first use and removes it after about 60 s idle (steamdeck-mcp does the same). This avoids a phantom player-2 controller.
  - Caps the rate at about 1000 events per second.

**WebSocket `GET /input`** (bearer or cookie, same Origin check as today; refused unless input is enabled). Messages:
```json
{"type":"key","code":30,"down":true}            // evdev code; or {"key":"KeyA"} mapped server-side
{"type":"text","text":"hello"}                  // US-layout ASCII -> keycode+shift; non-ASCII -> CDP insertText if the Steam UI has focus, else error
{"type":"mouse_move","x":0.503,"y":0.505}       // absolute, normalised 0..1
{"type":"mouse_move","dx":3,"dy":-1}            // relative (pointer-lock mode)
{"type":"mouse_button","button":"left","down":true}
{"type":"wheel","dx":0,"dy":-1}                 // detents; libei scroll_discrete uses 120 per detent
{"type":"gamepad","buttons":{"a":true},"axes":{"lx":0.0,"ly":-1.0,"lt":0.5},"hat":[0,-1]}
```
The server answers `{"type":"state","enabled":true,"backend":"ei"|"uinput","focus_size":[w,h]}`. For absolute moves the server scales `x` by the focused window's size.

**Viewer:**
- **Mapping clicks on the scaled image:** take `getBoundingClientRect()` of the `<img>`, allow for `object-fit: contain` letterboxing (`scale = min(rw/1920, rh/1080)`, offsets), then `nx = (clientX - left - offX) / (1920 * scale)`, clamped to 0..1.
- **Keys:** use `KeyboardEvent.code` (layout-independent physical key) with `preventDefault`. Ignore auto-repeat (`e.repeat`), because gamescope and the app do their own repeat.
- **Modifiers:** send Shift/Ctrl/Alt/Meta as ordinary keys. On `blur` or `visibilitychange`, send a release for every key still held.
- **Two modes:**
  - "UI" (absolute, cursor visible).
  - "Game" (Pointer Lock API, `movementX/Y` sent as relative moves, Escape exits). Use `requestPointerLock({unadjustedMovement: true})` where supported.
- **Gamepad:** forward a pad plugged into the viewer machine through the Gamepad API, polled at 60–125 Hz. Standard mapping indices 0–3 map to A/B/X/Y, 4/5 to TL/TR, 6/7 to the triggers, 8/9 to Back/Start, 10/11 to the stick clicks, 12–15 to the D-pad, 16 to Guide.

**KeyboardEvent.code to Linux KEY_ table** (from `input-event-codes.h`; Chromium's `ui/events/keycodes/dom/dom_code_data.inc` is the authoritative source, where evdev = XKB code - 8):
```
KeyA:30 KeyB:48 KeyC:46 KeyD:32 KeyE:18 KeyF:33 KeyG:34 KeyH:35 KeyI:23 KeyJ:36 KeyK:37 KeyL:38 KeyM:50
KeyN:49 KeyO:24 KeyP:25 KeyQ:16 KeyR:19 KeyS:31 KeyT:20 KeyU:22 KeyV:47 KeyW:17 KeyX:45 KeyY:21 KeyZ:44
Digit1..9:2..10 Digit0:11 F1..F10:59..68 F11:87 F12:88 F13..F24:183..194
Escape:1 Minus:12 Equal:13 Backspace:14 Tab:15 BracketLeft:26 BracketRight:27 Enter:28 ControlLeft:29
Semicolon:39 Quote:40 Backquote:41 ShiftLeft:42 Backslash:43 Comma:51 Period:52 Slash:53 ShiftRight:54
AltLeft:56 Space:57 CapsLock:58 NumLock:69 ScrollLock:70 IntlBackslash:86 IntlRo:89 ControlRight:97
PrintScreen:99 AltRight:100 Home:102 ArrowUp:103 PageUp:104 ArrowLeft:105 ArrowRight:106 End:107
ArrowDown:108 PageDown:109 Insert:110 Delete:111 Pause:119 IntlYen:124 MetaLeft:125 MetaRight:126 ContextMenu:127
Numpad7:71 Numpad8:72 Numpad9:73 NumpadSubtract:74 Numpad4:75 Numpad5:76 Numpad6:77 NumpadAdd:78
Numpad1:79 Numpad2:80 Numpad3:81 Numpad0:82 NumpadDecimal:83 NumpadEnter:96 NumpadDivide:98
NumpadMultiply:55 NumpadEqual:117 AudioVolumeMute:113 AudioVolumeDown:114 AudioVolumeUp:115
MediaPlayPause:164 MediaTrackNext:163 MediaTrackPrevious:165 MediaStop:166
```

**MCP tools** (refused when input is disabled):
- `input_key(keys: "ctrl+shift+a" | ["KEY_ENTER"], hold_ms=50)`. The hold matters because games poll once per frame.
- `input_text(text, delay_ms=10)`.
- `input_mouse(x?, y?, dx?, dy?, button?, action: move|click|double|down|up|scroll, amount?)`. Coordinates are normalised 0..1, or pixels if `pixels=true`.
- `input_gamepad(buttons?, axes?, hold_ms=100, sequence?)`. `sequence` is a list of steps such as `{"press":"a"}` or `{"stick":"l","x":0,"y":-1,"ms":300}`. Guide opens the Steam menu.
- Each tool returns a fresh `screen_capture` frame when asked, so an agent can check the result.

**Security:**
- Injected input is full control of the device (Steam store purchases, Desktop Mode, terminals). Keep it behind the bearer token or cookie and the Origin check.
- Input should be **off by default**: a toggle in the Decky panel (persisted, plus an optional auto-off after N minutes).
- Show a toast and an icon on the Deck whenever an input session starts, with the remote IP, the same way pairing does.
- MCP input tools should require the bearer token only, not the cookie.
- Log every input session.
- Never accept input during the unauthenticated pairing window.
- Always release held keys and buttons on disconnect.

**Effort, about 2.5–3.5 days:**

| Work | Estimate |
|---|---|
| `uinput.py` and `ei.py` with reconnect/fallback | 0.5 d |
| Input service: state, release-on-drop, pad lifecycle, focus-size lookup | 0.5 d |
| WebSocket endpoint and MCP tools | 0.5 d |
| Viewer (mapping, two modes, pointer lock, key table, Gamepad API) | 0.75–1 d |
| Panel toggle and toast | 0.25 d |
| Device tests on Bazzite (and SteamOS if available), including in a game | 0.5 d |

## Sources
- Kernel uinput documentation: https://docs.kernel.org/input/uinput.html, plus `<linux/uinput.h>` and `<linux/input.h>` (struct and ioctl values checked with gcc)
- gamescope 3.16.23 source (commit f8b33d38), all under https://github.com/ValveSoftware/gamescope:
  - `src/wlserver.cpp`: `wlserver_new_input`, `wlserver_mousemotion` / `_mousewarp`, `wlserver_touchdown` / `_touchmotion`, `wlserver_get_cursor_bounds`
  - `src/InputEmulation.cpp`: the libei server
  - `src/main.cpp:229`: touch modes
- OpenGamingCollective gamescope fork (`--touch-gestures`): https://github.com/OpenGamingCollective/gamescope, `src/wlserver.cpp` around line 3600
- Prior art: [mpsijben/steamdeck-mcp](https://github.com/mpsijben/steamdeck-mcp) (xdotool on the front Xwayland, uinput X360 pad unplugged after a minute idle) and [TuxLux40/decky-claude](https://github.com/TuxLux40/decky-claude) (xdotool, with ydotool as a fallback; both installed in Desktop Mode)
- Search for `--touch-gestures` (not in upstream; one result was the separate [LegionBetterSpace](https://github.com/LorenzoMorelli/LegionBetterSpace) gestures tool): [gamescope issue #1606](https://github.com/ValveSoftware/gamescope/issues/1606)
