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
  <a href="#install">Install</a> ·
  <a href="extension/README.md">VS Code extension</a> ·
  <a href="docs/reference.md">Reference</a>
</p>

## Features

- One-click deploy from VS Code / VSCodium that reloads just your plugin in seconds.
- Deploy on change, so the device follows your edits.
- Live view of the Deck's screen, with sound, in an editor tab or any browser.
- Keyboard, mouse and gamepad input sent straight to the device.
- Virtual controllers and one-step jumps to any Steam page or your plugin's Quick Access panel.
- Loader and plugin logs streamed into VS Code output channels.
- JavaScript console for Steam's `SharedJSContext`.
- HTTP API and MCP server for your own tools and agents.
- Pairing approved on the device, with bearer-token auth.

## Install

- Extension: `code --install-extension jackhric.decky-toolkit` (or `codium`).
- Plugin: in Decky developer mode, use **Install Plugin from URL** with `jackhric.github.io/decky-toolkit/decky-toolkit.zip`.
- Pair: add the device's IP in the Decky view and approve the code in Quick Access → **Decky Toolkit**.
- Deploy: open your plugin folder and press <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>D</kbd>.

## Docs

- [VS Code extension guide](extension/README.md)
- [Plugin reference and HTTP API](docs/reference.md)

## AI Disclaimer

Built with heavy use of [Claude Code](https://claude.com/claude-code), so it is not in the default Decky Plugin Store, which [does not accept LLM-generated code](https://wiki.deckbrew.xyz/en/plugin-dev/submitting-plugins#ai-llms-and-so-on).

## License

[MIT](LICENSE)
