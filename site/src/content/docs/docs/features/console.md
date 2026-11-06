---
title: Poke the Steam UI
description: Evaluate JavaScript in Steam's SharedJSContext to inspect and test UI code live.
sidebar:
  order: 4
---

Decky plugin frontends run inside the Steam UI's `SharedJSContext`, where `window.DeckyPluginLoader` lives.
**Decky: Evaluate JS in Steam UI** (in the sidebar's **Steam** group) runs an expression there and shows the
result in a message or the **Decky Toolkit Console** output channel.

```js
location.pathname
// '/routes/library/home'
```

Under the hood it uses the plugin's `cef_evaluate` tool, which talks to Steam's Chrome DevTools endpoint on
the device. Related tools:

| Tool | What it does |
| --- | --- |
| `cef_targets` | List Steam's DevTools tabs |
| `cef_evaluate` | Run JavaScript in a Steam tab (default `SharedJSContext`) |
| `cef_screenshot` | PNG screenshot of a Steam tab |
| `ui_toast` | Show a Decky toast in the Steam UI |

:::caution
`cef_evaluate` is intentionally powerful: anyone paired with the device can run code in the Steam UI.
:::
