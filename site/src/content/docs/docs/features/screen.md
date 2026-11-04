---
title: Remote control
description: Remotely control and command your device from your editor.
sidebar:
  order: 2
---

## Live screen

Run **Decky: Open screen** for the device's live display in an editor tab. The default is 30 fps at 1080p.
**Stream** in the panel's toolbar sets the frame rate (15/24/30/60 fps), JPEG quality and width; a change
applies without reconnecting.

Stream settings are device-wide: every editor panel and tool call shares one capture pipeline, and the last
change wins. Capture comes from gamescope's own PipeWire node, so games are included and nothing needs to be
installed.

## Sound

The stream has sound, on by default. The mute button and volume slider affect only your panel. **Audio** in
the **Stream** settings turns it off for every client.

## Remote input

Remote input is **off by default**. Turn it on with the **Input** button in the screen panel's toolbar,
**Decky: Toggle remote input**, or **Allow remote input** in the Decky Toolkit panel on the device.

- **Mouse and keyboard:** click the picture to capture input. Pointer positions land exactly on the Steam UI,
  and keys are sent by physical position, so your editor's keybindings don't fire while the picture has focus.
- **Gamepad:** a controller connected to your computer is forwarded to the device as an Xbox 360 pad while
  the panel has focus. **Forward to** picks which pad on the device it drives.
- **Virtual controllers:** add up to four virtual Xbox 360 pads from the extension's **Controllers** view;
  Steam Input sees them like real controllers.
- **Jump to page:** **Decky: Navigate Steam UI to…** opens any Steam or Decky page, a game's page or a plugin's
  Quick Access panel.

:::caution
Remote input is full control of the device. The device shows a toast when a client starts sending input,
and every input session is written to the plugin log.
:::
