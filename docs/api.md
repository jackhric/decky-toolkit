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

## Pairing

| Route | Auth | Status | Notes |
| --- | --- | --- | --- |
| `GET /pair` | none, only while pairing is open | live | Returns `{token, url, api_version}` (`url` is `http://<ip>:<port>`, no path) so a client (VS Code extension, CLI) can obtain the token during the 120 s window opened from the Decky panel. Outside the window: `403 {"error":"pairing closed"}`; a foreign `Origin` also gets `403`. Each grant increments the panel's pairing counter and emits the `decky_mcp_paired` event. |

## Plugins

| Route | Auth | Status | Notes |
| --- | --- | --- | --- |
| `POST /plugins/install` | bearer | live | Body: `multipart/form-data` with field `file` (a plugin zip as produced by the Decky CLI or `scripts/deploy.sh` staging: either `<name>/...` as the single top-level dir, or files at the zip root). Query: `restart=loader` (default) \| `plugin` \| `none`. Validates `plugin.json` (string `name`, string `author`, list `flags`, int `api_version`) and refuses absolute paths, `..` and symlinks (`400 {"error"}`). The dir name is the zip's top-level dir, else `name` with spaces turned into `-`. Installs to `~/homebrew/plugins/<dirname>` atomically (unzip to a temp dir next to `plugins/`, D0755/F0644 root:root, swap). `version` comes from `package.json` (may be `null`). Response `{installed: {dir, name, version}, restarted: "loader"|"plugin"|"none"}`. `restart=loader`: the zip is unpacked to `~/homebrew/.decky-mcp-pending/<dirname>` and, 1 s after the reply, a transient systemd unit stops the loader, swaps the dir in and starts the loader again (a swap the loader's file watcher sees while it is stopping leaves an orphaned, memory-leaking backend). `restart=plugin`: as `POST /plugins/{dir}/reload` after the swap; the plugin must already be loaded (a first install needs `loader`). `restart=none`: for a plugin with the `debug` flag the loader's file watcher re-imports it on its own 1-3 s later, usually twice (once per changed file); asking for `plugin` as well adds another reload. |
| `GET /plugins` | bearer/cookie | live | Same as the `list_plugins` tool. |
| `POST /plugins/{dir}/reload` | bearer | live | Re-import one plugin via Decky (`loader/reload_plugin`, called through `window.DeckyBackend` in SharedJSContext) without restarting the loader: the loader stops and restarts its backend, logs `Loaded <name> (v<version>)` and tells the frontend to import `dist/index.js` again (cache-busted), so both halves update (verified 2026-11-04, with and without the `debug` flag). `{dir, name, scheduled}`; reloading Decky-MCP itself is deferred 1 s (`scheduled: true`). `404` if the dir has no `plugin.json`, `502` if the Steam UI is unreachable. |
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
`POST /plugins/install`), `reload_plugin` (`dir`).

## Events (backend → Decky frontend)

| Event | Payload | Meaning |
| --- | --- | --- |
| `decky_mcp_paired` | `remote_ip: string` | a client was granted access during pairing |

## Errors

Non-MCP routes return plain text or `{"error": "<message>"}` with a conventional status code.
MCP tool failures are returned inside the JSON-RPC result with `isError: true`, never as HTTP errors.
