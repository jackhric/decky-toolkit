# Changelog

## [0.4.0](https://github.com/jackhric/decky-toolkit/compare/plugin-v0.3.0...plugin-v0.4.0) (2026-11-06)


### ⚠ BREAKING CHANGES

* rename and merge the MCP tools into one <area>_<action> scheme ([#81](https://github.com/jackhric/decky-toolkit/issues/81))

### Features

* keep agents' tool lists current, refuse unknown arguments, add backend stack dumps ([#79](https://github.com/jackhric/decky-toolkit/issues/79)) ([f884efb](https://github.com/jackhric/decky-toolkit/commit/f884efbc1d02cb8b65191a823b2114a6d8f5ade5))
* live sync for plugin development ([#78](https://github.com/jackhric/decky-toolkit/issues/78)) ([f8d3b99](https://github.com/jackhric/decky-toolkit/commit/f8d3b9922a13c876f02bf6a3ea1a3d9a764ecaa4))
* rename and merge the MCP tools into one &lt;area&gt;_&lt;action&gt; scheme ([#81](https://github.com/jackhric/decky-toolkit/issues/81)) ([45ad870](https://github.com/jackhric/decky-toolkit/commit/45ad870abf905b7150a4d7c5df7a18643b1f4750))
* shell, activity, UI state and log tools for agents on the device ([#80](https://github.com/jackhric/decky-toolkit/issues/80)) ([09fae06](https://github.com/jackhric/decky-toolkit/commit/09fae06637f53ed9c362ba84339a612cd49ddae9))


### Bug Fixes

* stop the backend within the loader's grace period on reload ([#76](https://github.com/jackhric/decky-toolkit/issues/76)) ([9c08936](https://github.com/jackhric/decky-toolkit/commit/9c08936b65bd76cbd6ecceb45b8999dd2b26a57a))

## [0.3.0](https://github.com/jackhric/decky-toolkit/compare/plugin-v0.2.1...plugin-v0.3.0) (2026-11-06)


### ⚠ BREAKING CHANGES

* pair with mutual TLS and relay MCP through the extension ([#59](https://github.com/jackhric/decky-toolkit/issues/59))
* **server:** serve over mutual TLS and pair with client certificates
* show device versions and remove manual pairing ([#48](https://github.com/jackhric/decky-toolkit/issues/48))
* make the screen panel native and drop the browser viewer ([#43](https://github.com/jackhric/decky-toolkit/issues/43))

### Features

* accept several paired clients on a device ([#63](https://github.com/jackhric/decky-toolkit/issues/63)) ([16ca677](https://github.com/jackhric/decky-toolkit/commit/16ca6770993f7890578ff454f43749769d14f884))
* add game files, recording, perf overlay, console and UI query tools with a Games view ([#42](https://github.com/jackhric/decky-toolkit/issues/42)) ([97c3170](https://github.com/jackhric/decky-toolkit/commit/97c3170d5332704cdfaff2a8b58e8731d4c30128))
* discover Decky Toolkit devices on the local network ([#45](https://github.com/jackhric/decky-toolkit/issues/45)) ([42e8c0b](https://github.com/jackhric/decky-toolkit/commit/42e8c0b9dc40dfb784366432545c9c300391e398))
* **extension:** share the device client and keep the pairing in a per-machine identity file ([#64](https://github.com/jackhric/decky-toolkit/issues/64)) ([2776937](https://github.com/jackhric/decky-toolkit/commit/27769374f97a2feb2f46b3f19fa33485328e02c6))
* make the screen panel native and drop the browser viewer ([#43](https://github.com/jackhric/decky-toolkit/issues/43)) ([2ffc5bb](https://github.com/jackhric/decky-toolkit/commit/2ffc5bb908992f5cf6683cdc4a27f7ded89b5f8c))
* pair with mutual TLS and relay MCP through the extension ([#59](https://github.com/jackhric/decky-toolkit/issues/59)) ([3b629bd](https://github.com/jackhric/decky-toolkit/commit/3b629bd3c241b648b2a3b1f924fd3a94af0ab256))
* **panel:** list paired clients with a Forget button ([2535979](https://github.com/jackhric/decky-toolkit/commit/2535979f2cb38089af926fb9eb695a36dc0ab3cd))
* **panel:** show the connected editor and a disconnect button ([#61](https://github.com/jackhric/decky-toolkit/issues/61)) ([626ca8f](https://github.com/jackhric/decky-toolkit/commit/626ca8f507feada4b120969eb002fb87c139b5e0))
* **server:** serve over mutual TLS and pair with client certificates ([89f7607](https://github.com/jackhric/decky-toolkit/commit/89f760784825f417afca0364644c8921ff6f54d3))
* show device versions and remove manual pairing ([#48](https://github.com/jackhric/decky-toolkit/issues/48)) ([ed4665b](https://github.com/jackhric/decky-toolkit/commit/ed4665bfe038edbb0dd115b07ed4c4ee36cc51c3))


### Bug Fixes

* **server:** refuse Decky Toolkit's pairing decisions through call_plugin_method ([ec809fc](https://github.com/jackhric/decky-toolkit/commit/ec809fc7b9c22d491a17717f1223e5af3384a158))

## [0.2.1](https://github.com/jackhric/decky-toolkit/compare/plugin-v0.2.0...plugin-v0.2.1) (2026-11-04)


### Bug Fixes

* **extension:** center the icon on a light tile for dark themes ([#9](https://github.com/jackhric/decky-toolkit/issues/9)) ([50c8652](https://github.com/jackhric/decky-toolkit/commit/50c8652660f74e4fc84c5b289085ffc99e14ccdd))
