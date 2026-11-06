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
  <a href="https://github.com/jackhric/decky-toolkit/releases"><img alt="Decky Plugin version" src="https://img.shields.io/github/package-json/v/jackhric/decky-toolkit?label=Decky%20Plugin&color=9C6AEC"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=jackhric.decky-toolkit"><img alt="VS Code Marketplace" src="https://img.shields.io/github/package-json/v/jackhric/decky-toolkit?filename=extension%2Fpackage.json&label=VS%20Code%20Marketplace&color=0AA5FF&logo=data:image/svg%2bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMDAgMTAwIj48cGF0aCBmaWxsPSIjZmZmIiBmaWxsLXJ1bGU9ImV2ZW5vZGQiIGQ9Ik03MC45IDk5LjZDNzIuNSAxMDAuMiA3NC4zIDEwMC4yIDc1LjkgOTkuNEw5Ni41IDg5LjRDOTguNiA4OC40IDEwMCA4Ni4yIDEwMCA4My44VjE2LjJDMTAwIDEzLjggOTguNiAxMS42IDk2LjUgMTAuNkw3NS45IDAuNkM3My44LTAuNCA3MS4zLTAuMSA2OS41IDEuMkM2OS4zIDEuNCA2OSAxLjYgNjguOCAxLjhMMjkuNCAzOEwxMi4yIDI0LjlDMTAuNiAyMy43IDguNCAyMy44IDYuOSAyNS4xTDEuNCAzMC4yQy0wLjUgMzEuOC0wLjUgMzQuNyAxLjQgMzYuM0wxNi4yIDUwTDEuNCA2My43Qy0wLjUgNjUuMy0wLjUgNjguMiAxLjQgNjkuOEw2LjkgNzQuOUM4LjQgNzYuMiAxMC42IDc2LjMgMTIuMiA3NS4xTDI5LjQgNjJMNjguOCA5OC4yQzY5LjQgOTguOCA3MC4xIDk5LjMgNzAuOSA5OS42Wk03NSAyNy4yTDQ1LjEgNTBMNzUgNzIuOFYyNy4yWiIvPjwvc3ZnPg=="></a>
  <a href="https://open-vsx.org/extension/jackhric/decky-toolkit"><img alt="Open VSX" src="https://img.shields.io/open-vsx/v/jackhric/decky-toolkit?label=Open%20VSX&color=0AA5FF&logo=vscodium&logoColor=white"></a>
  <a href="https://www.npmjs.com/package/decky-toolkit"><img alt="npm" src="https://img.shields.io/npm/v/decky-toolkit?label=npm&color=CB3837&logo=npm&logoColor=white"></a>
  <img alt="Platform: SteamOS and Bazzite" src="https://img.shields.io/badge/platform-SteamOS%20%7C%20Bazzite-555">
</p>

<p align="center">
  <a href="#features">Features</a> ·
  <a href="#getting-started">Getting started</a> ·
  <a href="extension/README.md">VS Code extension</a> ·
  <a href="docs/reference.md">Reference</a>
</p>

<p align="center">
  <img alt="VS Code with plugin code, the SteamOS device's live screen showing the plugin's Quick Access panel, and the plugin's logs streaming below" src="docs/images/media/hero.png">
</p>

<p align="center">
  <img alt="A game's save files and an .ini opened from the SteamOS device over decky://, next to the game's page on the live screen" src="docs/images/media/games-files.png">
</p>

## Features

- Live reload your plugin on save for both frontend and backend
- Remote screen with sound and keyboard, mouse and gamepad input
- Decky Loader, plugin and Steam UI logs in VS Code
- Launch games and browse their files and saves
- An extendable MCP server for coding agents: add your plugin's own tools

## Getting started

### Requirements

- A SteamOS or Bazzite device with [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader) 3.3+.
- VS Code 1.90+ or VSCodium.

### 1. Install the extension

<p align="center">
  <img alt="Installing Decky Toolkit from the Extensions view in VS Code" src="docs/images/install/vscode-install.gif" width="800">
</p>

Or from a terminal:

```sh
code --install-extension jackhric.decky-toolkit
codium --install-extension jackhric.decky-toolkit
```

### 2. Install the Decky Plugin

1. On the device turn on Decky settings → **General** → **Other** → **Developer mode**.
2. Open **Developer** → **Third-Party Plugins** → **Install Plugin from URL**.
3. Enter `jackhric.github.io/decky-toolkit/decky-toolkit.zip` and press **Install**.

### 3. Pair

1. In VS Code click the **Decky** icon in the Activity Bar and add the device's IP address with **+**.
2. Click the device. VS Code shows a four-digit code.
3. On the device open Quick Access → **Decky Toolkit** and approve the matching code.

### 4. Deploy

Open your plugin's folder and press <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>D</kbd>
(<kbd>Cmd</kbd>+<kbd>Alt</kbd>+<kbd>D</kbd> on macOS) or click **Deploy** in the status bar.

See the [extension guide](extension/README.md) and the [reference](docs/reference.md) for more.

## AI Disclaimer

This project was built with heavy use of [Claude Code](https://claude.com/claude-code). The Decky
Plugin Store does not accept LLM-generated code
([guidelines](https://wiki.deckbrew.xyz/en/plugin-dev/submitting-plugins#ai-llms-and-so-on)) so it is
not listed there.

## License

[MIT](LICENSE)
