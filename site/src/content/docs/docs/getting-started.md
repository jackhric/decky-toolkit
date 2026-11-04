---
title: Get started
description: Install the extension and the plugin, pair your editor with the device, and deploy.
---

You need a SteamOS device running [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader) 3.3 or
newer, and VS Code 1.90+ or VSCodium on your computer.

## 1. Install the extension

Search for **Decky Toolkit** in the Extensions view, or install it from a terminal:

```sh
code --install-extension jackhric.decky-toolkit     # VS Code
codium --install-extension jackhric.decky-toolkit   # VSCodium
```

The extension is on the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=jackhric.decky-toolkit)
and [Open VSX](https://open-vsx.org/extension/jackhric/decky-toolkit).

## 2. Install the plugin on your SteamOS device

1. In Decky's settings, turn on **General → Other → Developer mode**.
2. Open **Developer → Third-Party Plugins → Install Plugin from URL** and enter:

   ```text
   jackhric.github.io/decky-toolkit/decky-toolkit.zip
   ```

3. Decky warns about third-party plugins (**Continue** unlocks after a few seconds), then asks you to confirm.

Open Quick Access (…) → **Decky Toolkit**. The panel shows the device's IP address.

## 3. Pair your editor

1. Click the **Decky** icon in the Activity Bar, then **Add device**, and enter the IP address.
2. Click the device. The editor shows a four-digit code.
3. The device shows a toast with the same code. In Quick Access → **Decky Toolkit**, check the code and
   press **Approve**.

The token never has to be typed in. A request waits as long as the editor is waiting.

## 4. Deploy your plugin

Open your plugin's folder (any folder with a `plugin.json`) and press <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>D</kbd>.
See [Hot reload your plugin](../features/deploy/) for what happens.
