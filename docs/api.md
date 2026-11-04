# Decky-MCP HTTP API

Base URL: `http://<deck-ip>:8765`. Everything except `/`, `/health` and the viewer's own token /
pairing handling requires either `Authorization: Bearer <token>` or the `decky_mcp_token` cookie.
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
| `GET /stream.mjpeg` | bearer/cookie | live | `multipart/x-mixed-replace; boundary=frame`, JPEG parts with `Content-Length`. 30 fps default. |
| `GET /frame.jpg` | bearer/cookie | live | One current JPEG frame. `503` with a reason if capture is unavailable. |
| `GET /stream/stats` | bearer/cookie | live | `{available, running, subscribers, fps, kbps, frames_total, uptime_s, width, height, settings{fps,quality,width}, error}` |

## Pairing

| Route | Auth | Status | Notes |
| --- | --- | --- | --- |
| `GET /pair` | none, only while pairing is open | planned | Returns `{token, url, api_version}` so a client (VS Code extension, CLI) can obtain the token during the 120 s window opened from the Decky panel. Outside the window: `403 {"error":"pairing closed"}`. Each grant increments the panel's pairing counter and emits the `decky_mcp_paired` event. |

## Plugins

| Route | Auth | Status | Notes |
| --- | --- | --- | --- |
| `POST /plugins/install` | bearer | planned | Body: `multipart/form-data` with field `file` (a plugin zip as produced by the Decky CLI or `scripts/deploy.sh` staging: either `<name>/...` as the single top-level dir, or files at the zip root). Query: `restart=loader` (default) \| `plugin` \| `none`. Validates `plugin.json` (`name`, `author`, `flags`, `api_version`) and refuses path traversal. Installs to `~/homebrew/plugins/<dirname>` atomically (unzip to a temp dir, swap). Response `{installed: {dir, name, version}, restarted: "loader"|"plugin"|"none"}`. With `restart=loader` the reply is sent before the restart fires 1 s later. |
| `GET /plugins` | bearer/cookie | planned | Same as the `list_plugins` tool. |
| `POST /plugins/{dir}/reload` | bearer | planned | Reload one plugin's backend via Decky (`loader/reload_plugin`) without restarting the loader. |
| `POST /loader/restart` | bearer | planned | Same as the `restart_loader` tool. |

## Logs

| Route | Auth | Status | Notes |
| --- | --- | --- | --- |
| `GET /logs/stream` | bearer/cookie | planned | `text/event-stream`. Query: `source=loader` (journal, default) \| `plugin`, `plugin=<dir>` for plugin logs, `tail=<n>` initial lines (default 100). Events: `data: <one log line>`; a comment `: keepalive` every 15 s. |
| `GET /logs/tail` | bearer/cookie | planned | Same filters, returns `{lines: [...]}` once. |

## MCP tools (live)

`decky_status`, `list_plugins`, `read_plugin_log`, `loader_log`, `restart_loader`, `cef_targets`,
`cef_evaluate`, `cef_screenshot`, `toast`, `screen_capture`, `stream_status`, `read_file`,
`write_file`. Planned additions mirror the planned routes: `install_plugin` (path on device or
base64 zip), `reload_plugin`.

## Events (backend → Decky frontend)

| Event | Payload | Meaning |
| --- | --- | --- |
| `decky_mcp_paired` | `remote_ip: string` | a client was granted access during pairing |

## Errors

Non-MCP routes return plain text or `{"error": "<message>"}` with a conventional status code.
MCP tool failures are returned inside the JSON-RPC result with `isError: true`, never as HTTP errors.
