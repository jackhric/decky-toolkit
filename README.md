<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/decky-toolkit-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="assets/decky-toolkit-light.svg">
    <img alt="Decky Toolkit" src="assets/decky-toolkit-light.svg" width="480">
  </picture>
</p>

<p align="center">
  <b>Build, deploy and test Decky Loader plugins with improved DX and speed straight from your IDE (VSCode / VSCodium)</b>
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
  <a href="https://github.com/jackhric/decky-toolkit/actions/workflows/ci.yml?query=branch%3Amain"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/jackhric/decky-toolkit/ci.yml?branch=main&label=CI&logo=githubactions&logoColor=white"></a>
  <a href="https://github.com/jackhric/decky-toolkit/releases"><img alt="Plugin version" src="https://img.shields.io/github/package-json/v/jackhric/decky-toolkit?label=plugin&color=9C6AEC"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=jackhric.decky-toolkit"><img alt="VS Code Marketplace" src="https://img.shields.io/github/package-json/v/jackhric/decky-toolkit?filename=extension%2Fpackage.json&label=VS%20Code%20Marketplace&color=0AA5FF&logo=data:image/svg%2bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMDAgMTAwIj48cGF0aCBmaWxsPSIjZmZmIiBmaWxsLXJ1bGU9ImV2ZW5vZGQiIGQ9Ik03MC45IDk5LjZDNzIuNSAxMDAuMiA3NC4zIDEwMC4yIDc1LjkgOTkuNEw5Ni41IDg5LjRDOTguNiA4OC40IDEwMCA4Ni4yIDEwMCA4My44VjE2LjJDMTAwIDEzLjggOTguNiAxMS42IDk2LjUgMTAuNkw3NS45IDAuNkM3My44LTAuNCA3MS4zLTAuMSA2OS41IDEuMkM2OS4zIDEuNCA2OSAxLjYgNjguOCAxLjhMMjkuNCAzOEwxMi4yIDI0LjlDMTAuNiAyMy43IDguNCAyMy44IDYuOSAyNS4xTDEuNCAzMC4yQy0wLjUgMzEuOC0wLjUgMzQuNyAxLjQgMzYuM0wxNi4yIDUwTDEuNCA2My43Qy0wLjUgNjUuMy0wLjUgNjguMiAxLjQgNjkuOEw2LjkgNzQuOUM4LjQgNzYuMiAxMC42IDc2LjMgMTIuMiA3NS4xTDI5LjQgNjJMNjguOCA5OC4yQzY5LjQgOTguOCA3MC4xIDk5LjMgNzAuOSA5OS42Wk03NSAyNy4yTDQ1LjEgNTBMNzUgNzIuOFYyNy4yWiIvPjwvc3ZnPg=="></a>
  <a href="https://open-vsx.org/extension/jackhric/decky-toolkit"><img alt="Open VSX" src="https://img.shields.io/open-vsx/v/jackhric/decky-toolkit?label=Open%20VSX&color=0AA5FF&logo=vscodium&logoColor=white"></a>
  <a href="https://github.com/SteamDeckHomebrew/decky-loader"><img alt="Decky Loader 3.3+" src="https://img.shields.io/badge/Decky%20Loader-3.3%2B-1B1B1B?logo=steam&logoColor=white"></a>
  <img alt="Platform: SteamOS and Bazzite" src="https://img.shields.io/badge/platform-SteamOS%20%7C%20Bazzite-555">
</p>

<p align="center">
  <a href="#features">Features</a> ·
  <a href="#getting-started">Getting started</a> ·
  <a href="extension/README.md">VS Code extension</a> ·
  <a href="docs/reference.md">Reference</a>
</p>

<p align="center">
  <img alt="VS Code with plugin code, the Deck's live screen showing the plugin's Quick Access panel, and the plugin's logs streaming below" src="docs/images/media/hero.png">
</p>

<p align="center">
  <img alt="A game's save files and an .ini opened from the Deck over decky://, next to the game's page on the live screen" src="docs/images/media/games-files.png">
</p>

## Features

- One-click deploy from VS Code / VSCodium that reloads just your plugin, with no loader restart.
- Hot reloading: the device follows your edits as you save.
- Live view of the Deck's screen, with sound, inside the extension.
- Keyboard, mouse and gamepad input sent straight to the device.
- Steam Input management and one-step jumps to any Steam page or your plugin's Quick Access panel.
- Loader and plugin logs streamed into VS Code output channels.
- JavaScript console for Steam's `SharedJSContext`.
- Games view: launch and stop games, and browse install dirs, Proton prefixes and saves as `decky://` folders.
- HTTP API and MCP server for your own tools and agents.
- Pairing approved on the device, with bearer-token auth.

## Getting started

### Requirements

- A Steam Deck, SteamOS or Bazzite device running [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader) 3.3 or newer.
- On your computer: VS Code 1.90+ (or VSCodium).

### 1. Install the extension in your IDE

<p align="center">
  <img alt="Installing Decky Toolkit from the Extensions view in VS Code" src="docs/images/install/vscode-install.gif" width="800">
</p>

Or if you fancy a terminal:

```sh
code --install-extension jackhric.decky-toolkit     # VS Code
codium --install-extension jackhric.decky-toolkit   # VSCodium
```

### 2. Install the plugin on the device

On the device, turn on Decky's developer mode (Decky settings → **General** → **Other** →
**Developer mode**). Then open **Developer** → **Third-Party Plugins** → **Install Plugin from URL**,
enter `jackhric.github.io/decky-toolkit/decky-toolkit.zip` (always the latest plugin release) and
press **Install**.

### 3. Pair your editor with the device

1. Click the **Decky** icon in the Activity Bar, then **Add device** (or **+**) and enter the
   device's IP address.
2. Click the device. VS Code shows a four-digit code.
3. The device shows a toast with the same code. In Quick Access → **Decky Toolkit**, check the
   code and press **Approve**.

### 4. Deploy your plugin

Open your plugin's folder in VS Code and press <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>D</kbd>
(<kbd>Cmd</kbd>+<kbd>Alt</kbd>+<kbd>D</kbd> on macOS), or use the **Deploy** button in the status
bar. The screen view opens on the first connect, so you see the result straight away.

The [extension guide](extension/README.md) covers every view and setting. The
[reference](docs/reference.md) covers the plugin itself, its HTTP API and how it works.

## AI Disclaimer

This project was built with heavy use of [Claude Code](https://claude.com/claude-code). Because of
this, the Decky Toolkit plugin will not be available in the default Decky Plugin Store, which does not
accept plugins that contain LLM-generated code (see its
[submission guidelines](https://wiki.deckbrew.xyz/en/plugin-dev/submitting-plugins#ai-llms-and-so-on)).
Install it from source as described in [Getting started](#getting-started).

## License

[MIT](LICENSE)
