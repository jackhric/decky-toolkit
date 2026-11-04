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
  <a href="https://github.com/jackhric/decky-toolkit/releases"><img alt="Plugin version" src="https://img.shields.io/github/package-json/v/jackhric/decky-toolkit?label=plugin&color=9C6AEC"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=jackhric.decky-toolkit"><img alt="VS Code Marketplace" src="https://img.shields.io/github/package-json/v/jackhric/decky-toolkit?filename=extension%2Fpackage.json&label=VS%20Code%20Marketplace&color=0AA5FF"></a>
  <a href="https://open-vsx.org/extension/jackhric/decky-toolkit"><img alt="Open VSX" src="https://img.shields.io/open-vsx/v/jackhric/decky-toolkit?label=Open%20VSX&color=0AA5FF"></a>
  <a href="https://github.com/SteamDeckHomebrew/decky-loader"><img alt="Decky Loader 3.3+" src="https://img.shields.io/badge/Decky%20Loader-3.3%2B-1B1B1B?logo=steam&logoColor=white"></a>
  <img alt="Platform: SteamOS and Bazzite" src="https://img.shields.io/badge/platform-SteamOS%20%7C%20Bazzite-555">
</p>

<p align="center">
  <a href="#why">Why</a> ·
  <a href="#getting-started">Getting started</a> ·
  <a href="extension/README.md">VS Code extension</a> ·
  <a href="docs/reference.md">Reference</a>
</p>

## Why

I've found that working on a Decky plugin with no additional tooling provides a slow development loop. This is a toolkit (VSCode / VSCodium extension + Decky Plugin) designed to speed up deployment and testing for your plugins.

- **One-click deploy:** The extension detects the plugin in your workspace, builds it only when
  its sources changed and reloads just that plugin in a few seconds, with no loader restart.
  Turn on deploy-on-change, keep your build in watch mode, and the device follows your edits.
- **See the & drive the target from your desk:** A live view of the Deck's screen, with sound, in an editor
  tab or any browser. Keyboard, mouse and your own gamepad go straight to the device.
  Add virtual controllers, jump to any Steam page or straight to your plugin's Quick Access panel.
- **Easy access logs:** Loader and plugin logs stream into VS Code output channels.
- **Poke the Steam UI:** A JavaScript console for Steam's `SharedJSContext`.
- **Scriptable:** Everything is also available over a small HTTP API (and MCP) for your own tools
  and scripts.

## Getting started

### Requirements

- A Steam Deck, SteamOS or Bazzite device running [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader) 3.3 or newer.
- On your computer: VS Code 1.90+ (or VSCodium).

The extension is on the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=jackhric.decky-toolkit)
and [Open VSX](https://open-vsx.org/extension/jackhric/decky-toolkit). Both pieces are also on the
[Releases](https://github.com/jackhric/decky-toolkit/releases) page: `plugin-v…` releases carry the
plugin zip, `extension-v…` releases the `.vsix`. Both are built by this repo's CI and signed with
build provenance, so you can check a download with
`gh attestation verify <file> -R jackhric/decky-toolkit`.

### 1. Install the plugin on the device

Download `decky-toolkit-<version>.zip` from the latest `plugin-v…` release. On the device, enable
Decky's developer mode (Decky settings → **General** → **Developer mode**), then go to
**Developer** → **Install Plugin From ZIP File** and pick the zip.

Open Quick Access (…) → **Decky Toolkit** on the device. The panel shows the device's IP address.

### 2. Install the VS Code extension

- **VS Code:** install
  [Decky Toolkit from the VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=jackhric.decky-toolkit),
  or search for "Decky Toolkit" in the Extensions view.
- **VSCodium and other editors that use Open VSX:** install
  [Decky Toolkit from Open VSX](https://open-vsx.org/extension/jackhric/decky-toolkit), or search
  for "Decky Toolkit" in the Extensions view.

From a terminal:

```sh
code --install-extension jackhric.decky-toolkit     # VS Code
codium --install-extension jackhric.decky-toolkit   # VSCodium
```

Offline or a specific version: download `decky-toolkit-<version>.vsix` from an `extension-v…`
release and use Extensions view → **…** → **Install from VSIX…**.

### Building from source

Needs Node 18+, pnpm 9+, rsync, and SSH key access to the device with passwordless `sudo`.

```sh
git clone https://github.com/jackhric/decky-toolkit.git
cd decky-toolkit
pnpm install
cp deploy.env.example deploy.env   # set DECK_HOST and DECK_USER for your device
pnpm run deploy                    # builds, copies to the device and restarts Decky Loader

cd extension
pnpm install
pnpm run package                   # creates decky-toolkit-<version>.vsix
code --install-extension decky-toolkit-<version>.vsix
```

### 3. Pair your editor with the device

1. Click the **Decky** icon in the Activity Bar, then **+** to add a device by its IP address.
2. Click the device. VS Code shows a four-digit code.
3. The device shows a toast with the same code. In Quick Access → **Decky Toolkit**, check the
   code and press **Approve**.

### 4. Deploy your plugin

Open your plugin's folder in VS Code and press <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>D</kbd>
(<kbd>Cmd</kbd>+<kbd>Alt</kbd>+<kbd>D</kbd> on macOS), or use the **Deploy** button in the status
bar. The screen view opens on the first connect, so you see the result straight away.

Prefer a browser? Open `http://<device-ip>:8765/viewer` and pair the same way.

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
