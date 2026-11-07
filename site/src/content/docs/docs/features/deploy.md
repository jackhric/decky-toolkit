---
title: Deploy and live reload
description: Deploy your Decky Loader plugin with one key and reload it on every save, without restarting Decky Loader.
sidebar:
  order: 2
---

Open your plugin's folder in VS Code. Any folder with a `plugin.json` works; the
[decky-plugin-template](https://github.com/SteamDeckHomebrew/decky-plugin-template) layout is expected.

## Deploy

Press <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>D</kbd>, click **Deploy** in the status bar, or click **Plugin → Deploy** in
the Actions view.

1. The extension builds the plugin if `src/` changed.
2. It installs the plugin on the device.
3. It reloads only your plugin. Decky Loader and the Steam UI keep running.

**Deploy (full restart)** restarts Decky Loader instead. The first deploy of a new plugin always does this.

Build output and errors go to the **Decky** output channel.

## Live reload

Turn on **Plugin → Auto-deploy on change**. The extension runs your plugin's `watch` script and pushes every
change to the device:

- A frontend change reloads only the frontend; the backend keeps running
- A Python change restarts the backend
- A `plugin.json` or `package.json` change deploys again

You stay where you were: the plugin's Quick Access panel, its page and the focused control. State inside your
components starts fresh after each reload.

If the plugin fails to load, the error shows in the **Decky** output channel with the line in your `src/` file.

## Other actions

- **Reload backend** restarts your plugin's backend without deploying
- **Show plugin logs** follows your plugin's log
- **Install plugin zip…** installs any plugin zip from disk

## Settings

| Setting | What it does |
| --- | --- |
| `decky-toolkit.deploy.onChange` | Auto-deploy on change, off by default |
| `decky-toolkit.deploy.build` | `auto` builds only when needed, or `always` / `never` |
| `decky-toolkit.deploy.watchBuild` | Run the `watch` script during auto-deploy, on by default |
| `decky-toolkit.pluginDirName` | Folder name on the device for a first install |

Without VS Code, run `npx -y decky-toolkit dev` in your plugin folder for the same live reload. See
[CLI and MCP](../cli/).
