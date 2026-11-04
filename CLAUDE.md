# Decky-MCP — notes for agents working in this repo

## What this is
A Decky Loader plugin whose Python backend hosts an MCP Streamable-HTTP server (port 8765, bearer
token) so external coding agents can inspect/control the Steam Deck during plugin development.
See README.md for the tool list and architecture.

## Layout
- `main.py` — Decky `Plugin` class: settings, aiohttp server lifecycle, frontend-callable methods.
- `py_modules/decky_mcp/` — `protocol.py` (JSON-RPC + HTTP transport), `tools.py` (tool registry
  and tools), `cdp.py` (Chrome DevTools client for Steam CEF on 127.0.0.1:8080), `settings.py`.
- `src/index.tsx` — Quick Access panel (React, `@decky/ui`, `@decky/api`). Built by `pnpm run build`
  into `dist/index.js`.
- `scripts/deploy.sh`, `scripts/smoke.sh`, `scripts/logs.sh` — read `deploy.env` (gitignored).

## Runtime facts (verified on the target device, 2026-11-03)
- Device: Bazzite `bazzite-deck-44.20261012`, host `bazzite`, IP 10.0.70.18, user `jackh`
  (wheel, passwordless sudo). SSH key auth works. Hostname does not resolve from the dev box; use the IP.
- Decky Loader v3.3.1 at `~/homebrew/services/PluginLoader`, runs as root. Bundled CPython is
  **3.14.8** (PyInstaller, extracted to `/tmp/_MEI*`). Plugin backends run as the loader's forkserver
  children; `py_modules/` is appended to `sys.path`. `aiohttp`, `yarl`, `multidict`, `certifi` are
  importable from the bundle. Do not ship cp311 wheels; prefer pure Python.
- `~/homebrew/plugins` is root-owned 755. Our deploy rsyncs to a user staging dir then `sudo rsync`s
  into place and restarts `plugin_loader`.
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
- The loader's file watcher loads a plugin whose files change even while shutting down, so
  `scripts/deploy.sh` stops the loader before syncing.
- Subprocesses inherit the PyInstaller `LD_LIBRARY_PATH`; `tools._run` strips it.
- `"debug"` in `plugin.json` flags enables hot reload on `dist/index.js`/`main.py` changes.

## Conventions
- Keep the MCP server dependency-free beyond the loader bundle (aiohttp + stdlib).
- Tools return str/dict (serialised to text) or a list of MCP content blocks. Raise `ValueError`
  for bad input; other exceptions become `isError` results with a traceback.
- Comments only for non-obvious *why*; match the sparse style.
