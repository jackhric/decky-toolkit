---
title: Hot reload your plugin
description: Save a file and just your Decky Loader plugin reloads on the device, without restarting Decky Loader.
sidebar:
  order: 1
---

The extension finds Decky plugins in your workspace: every folder with a `plugin.json`, in a workspace
folder or up to two levels below it. It installs to `~/homebrew/plugins/<folder name>` (the
`decky-toolkit.pluginDirName` setting overrides the name). Plugins are expected to follow the
[decky-plugin-template](https://github.com/SteamDeckHomebrew/decky-plugin-template) layout.

Turn on [deploy on change](#deploy-on-change) and every save reloads your plugin. To deploy on demand, press
<kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>D</kbd> or click `Deploy <name>` in the status bar.

## What a deploy does

1. **Build, only if needed.** With `decky-toolkit.deploy.build` set to `auto` (the default), `pnpm run build`
   runs only when a file under `src/` (or `tsconfig.json` / `rollup.config.*` / `vite.config.*`) is newer than
   `dist/index.js`. `main.py` and `py_modules/` never need a build.
2. **Stage and zip** what the template ships (`dist`, `plugin.json`, `package.json`, `main.py`, `py_modules`,
   `defaults`, `assets`, …), without `node_modules`, `__pycache__` and `.git`.
3. **Upload** to the device, which swaps the plugin directory atomically.
4. **Reload only this plugin.** Decky restarts its backend and the Steam UI imports the new frontend bundle,
   with no loader restart. The extension waits until the loader's log says `Loaded <name>`, then reports the time.

## Reload or full restart

A normal deploy reloads only your plugin. **Deploy (full restart)** restarts Decky Loader instead, which
also reloads the Steam UI. Use it when the plugin is not loaded yet; the first deploy
of a new plugin always restarts the loader.

## Deploy on change

Turn on **Plugin → Auto-deploy on change** (setting `decky-toolkit.deploy.onChange`). Changes to
`dist/index.js`, `main.py` or `py_modules/**/*.py` trigger a deploy shortly after the last change.
Keep `pnpm run watch` running so every save rebuilds the bundle.
