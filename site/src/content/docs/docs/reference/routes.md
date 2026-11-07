---
title: HTTP routes
description: Every HTTP route the Decky Toolkit plugin serves on port 8765, what it does and who may call it.
---

The plugin serves these routes on port `8765`. The extension and the CLI use them, and your own scripts can too.
"Paired client" means the caller must pair with the device first, the same way the extension does.

Request and response bodies are in [docs/api.md](https://github.com/jackhric/decky-toolkit/blob/main/docs/api.md).

## Public

| Method | Path | Purpose | Auth |
| --- | --- | --- | --- |
| GET | `/` | Says the server is running | none |
| GET | `/health` | Name, version and host name of the device | none |
| POST | `/api/v1/pair/request` | Ask the device to pair and get a code | none |
| GET | `/api/v1/pair/request/{id}` | Wait for the owner to approve or deny | none |
| DELETE | `/api/v1/pair/request/{id}` | Withdraw a pairing request | none |

## MCP

| Method | Path | Purpose | Auth |
| --- | --- | --- | --- |
| POST | `/mcp` | MCP server for coding agents | paired client |
| GET | `/mcp` | Not used, answers 405 | paired client |
| DELETE | `/mcp` | Not used, answers 405 | paired client |

## Screen, sound and input

| Method | Path | Purpose | Auth |
| --- | --- | --- | --- |
| GET | `/api/v1/stream` | Live screen as JPEG frames | paired client |
| GET | `/api/v1/stream/frame` | One screenshot | paired client |
| GET | `/api/v1/stream/stats` | Frame rate and bitrate of the stream | paired client |
| GET | `/api/v1/stream/settings` | Read the stream settings | paired client |
| PUT | `/api/v1/stream/settings` | Change frame rate, quality, size or sound | paired client |
| GET | `/api/v1/audio` | Sound, as a WebSocket | paired client |
| GET | `/api/v1/input` | Keyboard, mouse and gamepad input, as a WebSocket | paired client |
| GET | `/api/v1/input/settings` | Read whether remote input is on | paired client |
| PUT | `/api/v1/input/settings` | Turn remote input on or off | paired client |

## Controllers

| Method | Path | Purpose | Auth |
| --- | --- | --- | --- |
| GET | `/api/v1/controllers` | Controllers Steam Input sees | paired client |
| POST | `/api/v1/controllers/virtual` | Add a virtual Xbox 360 pad | paired client |
| DELETE | `/api/v1/controllers/virtual/{id}` | Remove a virtual pad | paired client |

## Steam UI

| Method | Path | Purpose | Auth |
| --- | --- | --- | --- |
| GET | `/api/v1/events` | Live changes to settings, plugins and controllers | paired client |
| GET | `/api/v1/ui/routes` | Pages you can open in the Steam UI | paired client |
| POST | `/api/v1/ui/navigate` | Open a page, a menu or a plugin panel | paired client |
| POST | `/api/v1/ui/toast` | Show a toast on the device | paired client |
| POST | `/api/v1/cef/evaluate` | Run JavaScript in the Steam UI | paired client |

## Plugins, loader and logs

| Method | Path | Purpose | Auth |
| --- | --- | --- | --- |
| GET | `/api/v1/plugins` | Installed plugins | paired client |
| POST | `/api/v1/plugins/install` | Install a plugin zip | paired client |
| POST | `/api/v1/plugins/reload` | Reload one plugin | paired client |
| PUT | `/api/v1/plugins/{dir}/files` | Replace one file of an installed plugin | paired client |
| POST | `/api/v1/loader/restart` | Restart Decky Loader | paired client |
| GET | `/api/v1/logs/tail` | Last lines of the loader log or a plugin log | paired client |
| GET | `/api/v1/logs/stream` | Follow the loader log or a plugin log | paired client |

## Games and files

| Method | Path | Purpose | Auth |
| --- | --- | --- | --- |
| GET | `/api/v1/apps` | Installed games and shortcuts | paired client |
| GET | `/api/v1/apps/{appid}/dirs` | A game's folders: install, prefix, cloud | paired client |
| GET | `/api/v1/apps/{appid}/saves` | Where a game keeps its saves | paired client |
| GET | `/api/v1/apps/{appid}/proton-log` | A game's Proton log | paired client |
| POST | `/api/v1/apps/{appid}/launch` | Start a game | paired client |
| POST | `/api/v1/apps/{appid}/terminate` | Quit a game | paired client |
| GET | `/api/v1/fs` | List a folder | paired client |
| DELETE | `/api/v1/fs` | Delete a file or folder | paired client |
| GET | `/api/v1/fs/read` | Read a file | paired client |
| PUT | `/api/v1/fs/write` | Write a file | paired client |
| POST | `/api/v1/fs/mkdir` | Make a folder | paired client |
| POST | `/api/v1/fs/rename` | Rename or move a file or folder | paired client |
