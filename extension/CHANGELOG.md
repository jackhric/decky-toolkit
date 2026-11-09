# Changelog

## [0.13.0](https://github.com/jackhric/decky-toolkit/compare/extension-v0.12.0...extension-v0.13.0) (2026-11-09)


### Features

* **extension:** create a new plugin from the Decky template ([291428b](https://github.com/jackhric/decky-toolkit/commit/291428b5da3dd0482594802c770f0467a81c941d))

## [0.12.0](https://github.com/jackhric/decky-toolkit/compare/extension-v0.11.0...extension-v0.12.0) (2026-11-07)


### ⚠ BREAKING CHANGES

* /api/v1/logs/tail and /logs/stream take plugin=<plugin.json name>; logs_read, logs_wait, plugin_methods, plugin_call and plugin_frontend_check take only the plugin.json name.

### Bug Fixes

* every plugin argument is the plugin.json name ([#112](https://github.com/jackhric/decky-toolkit/issues/112)) ([7847b4a](https://github.com/jackhric/decky-toolkit/commit/7847b4ae2b7b1cdbb633542f0cf9d614f00f4499))

## [0.11.0](https://github.com/jackhric/decky-toolkit/compare/extension-v0.10.0...extension-v0.11.0) (2026-11-07)


### ⚠ BREAKING CHANGES

* POST /api/v1/plugins/{dir}/reload?mode= is now POST /api/v1/plugins/reload with JSON {plugin, mode}, where plugin is the plugin.json name; plugin_reload takes only the name.

### Features

* **cli:** build before deploy, one deploy path with the extension ([#101](https://github.com/jackhric/decky-toolkit/issues/101)) ([c21632a](https://github.com/jackhric/decky-toolkit/commit/c21632a61691fe5b0a9516e8c46297f31f6b1054))


### Bug Fixes

* reload plugins by their plugin.json name ([#109](https://github.com/jackhric/decky-toolkit/issues/109)) ([a8d73e8](https://github.com/jackhric/decky-toolkit/commit/a8d73e8f44455fc3b4409ccda4815b9c4d656f51))

## [0.10.0](https://github.com/jackhric/decky-toolkit/compare/extension-v0.9.0...extension-v0.10.0) (2026-11-06)


### ⚠ BREAKING CHANGES

* versioned client API under /api/v1, trimmed routes ([#89](https://github.com/jackhric/decky-toolkit/issues/89))

### Features

* push device changes to clients over /api/v1/events ([#90](https://github.com/jackhric/decky-toolkit/issues/90)) ([9578ea8](https://github.com/jackhric/decky-toolkit/commit/9578ea8d0c25a735bc6ab47868660b989acaa3c3))
* versioned client API under /api/v1, trimmed routes ([#89](https://github.com/jackhric/decky-toolkit/issues/89)) ([4da45cb](https://github.com/jackhric/decky-toolkit/commit/4da45cb898d516e13f87c2e95ed6ac65095f8ce0))


### Bug Fixes

* list a plugin's tools when it loads during a registry sync ([#91](https://github.com/jackhric/decky-toolkit/issues/91)) ([44aea48](https://github.com/jackhric/decky-toolkit/commit/44aea48dc5f03f9a6dcf8564385f70c679871554))
* pre-release cleanup ([#92](https://github.com/jackhric/decky-toolkit/issues/92)) ([35d9029](https://github.com/jackhric/decky-toolkit/commit/35d9029e1443f480973fc48c3fd28edf2c825912))

## [0.9.0](https://github.com/jackhric/decky-toolkit/compare/extension-v0.8.0...extension-v0.9.0) (2026-11-06)


### ⚠ BREAKING CHANGES

* rename and merge the MCP tools into one <area>_<action> scheme ([#81](https://github.com/jackhric/decky-toolkit/issues/81))
* pair with mutual TLS and relay MCP through the extension ([#59](https://github.com/jackhric/decky-toolkit/issues/59))
* show device versions and remove manual pairing ([#48](https://github.com/jackhric/decky-toolkit/issues/48))
* make the screen panel native and drop the browser viewer ([#43](https://github.com/jackhric/decky-toolkit/issues/43))

### Features

* add game files, recording, perf overlay, console and UI query tools with a Games view ([#42](https://github.com/jackhric/decky-toolkit/issues/42)) ([97c3170](https://github.com/jackhric/decky-toolkit/commit/97c3170d5332704cdfaff2a8b58e8731d4c30128))
* **audio:** merge live audio stream and remove pointer-lock mode ([a522fe1](https://github.com/jackhric/decky-toolkit/commit/a522fe1de733d872082fc26281b8f631752bb05c))
* discover Decky Toolkit devices on the local network ([#45](https://github.com/jackhric/decky-toolkit/issues/45)) ([42e8c0b](https://github.com/jackhric/decky-toolkit/commit/42e8c0b9dc40dfb784366432545c9c300391e398))
* **extension:** add an HTTPS transport that pins the device and presents the client identity ([e8795f8](https://github.com/jackhric/decky-toolkit/commit/e8795f8073c24e5cdb5fb79ee87cb266ae2e4c5a))
* **extension:** add Decky sidebar with devices, plugins and preview ([4f06a0d](https://github.com/jackhric/decky-toolkit/commit/4f06a0df8267460768580cdc6d2846023d428671))
* **extension:** add live-switchable sidebar layouts and one-step pairing ([e64267f](https://github.com/jackhric/decky-toolkit/commit/e64267f9777902ace2ba64c7ef9862ff5f8c7ca9))
* **extension:** add stream settings, audio and fullscreen to the screen panel ([61af1e3](https://github.com/jackhric/decky-toolkit/commit/61af1e35d2be40aae2020100dac8e1e275e3d17a))
* **extension:** add VS Code extension with screen panel, deploy, logs and pairing ([c732c35](https://github.com/jackhric/decky-toolkit/commit/c732c358a42969301121fb73629c5d8df31ea917))
* **extension:** collapse Plugins and Controllers views by default ([f39b111](https://github.com/jackhric/decky-toolkit/commit/f39b1113fbf5dce0ae7b64e8562ef1f902564bd8))
* **extension:** controllers view, Steam UI navigation and gamepad forwarding target ([8df5b58](https://github.com/jackhric/decky-toolkit/commit/8df5b58f3bb0b1b49547a08b20dcc7e3ffd1918e))
* **extension:** detect the workspace plugin and deploy it with a plugin reload ([7644739](https://github.com/jackhric/decky-toolkit/commit/764473914776e566f4e7609bd2ec0965c8aaba07))
* **extension:** forward WebSocket upgrades through the loopback proxy ([e24819e](https://github.com/jackhric/decky-toolkit/commit/e24819e4cc637c6852a6c41df185b227d102e04d))
* **extension:** give the sidebar views relative initial sizes so Preview starts compact ([ed22db7](https://github.com/jackhric/decky-toolkit/commit/ed22db742857ea5ddf27c2953d1c8c6bb0620f3e))
* **extension:** group the Actions view and drop the sidebar layout bake-off ([56074f5](https://github.com/jackhric/decky-toolkit/commit/56074f57bc47ae0bd46bb2d0d6166ce3e25dedc3))
* **extension:** keep windows open and show a lost connection state ([#46](https://github.com/jackhric/decky-toolkit/issues/46)) ([fec17f2](https://github.com/jackhric/decky-toolkit/commit/fec17f29800873ced4650b27bfb6198a1bb28169))
* **extension:** merge controllers view, UI navigation and gamepad target ([c54c958](https://github.com/jackhric/decky-toolkit/commit/c54c958dc0d7246729ce5e16d14310ec8f29b8ae))
* **extension:** merge Decky sidebar, saved devices and theme styling ([65b3d75](https://github.com/jackhric/decky-toolkit/commit/65b3d75c1c67e4519c8f3633eead135555ebb0d2))
* **extension:** merge grouped Actions view and drop the layout bake-off ([0945bd7](https://github.com/jackhric/decky-toolkit/commit/0945bd7b8f35025436f798e9e08178018b0f3181))
* **extension:** merge plugin autodetection and one-click fast deploy ([242943b](https://github.com/jackhric/decky-toolkit/commit/242943b728eb7b3a624f17dad9a8cc86aed34ca3))
* **extension:** merge screen panel input toggle and capture ([9d4c4be](https://github.com/jackhric/decky-toolkit/commit/9d4c4be93968c7cde3f41df2bc0661d4361c9342))
* **extension:** merge switchable sidebar layouts and one-step pairing ([7a34f78](https://github.com/jackhric/decky-toolkit/commit/7a34f78b735ecfefef8db4ad2b72f7520fb510dc))
* **extension:** number controllers in Steam Input order and show 1-based slots ([2334995](https://github.com/jackhric/decky-toolkit/commit/2334995cbbde801bd850ebc58c9e4f370c1677c2))
* **extension:** pair by requesting approval on the device ([e2885b7](https://github.com/jackhric/decky-toolkit/commit/e2885b7bef6a089a4bc4e935b18e9aed23297a6e))
* **extension:** pair with a client key and relay MCP through a stable loopback proxy ([1d6885f](https://github.com/jackhric/decky-toolkit/commit/1d6885f642e495668ea815fcd5d078594de41b1a))
* **extension:** remote input toggle and capture in the screen panel ([6d80c9f](https://github.com/jackhric/decky-toolkit/commit/6d80c9fa53e73bda044231d6f091ef3fa2519df6))
* **extension:** share the device client and keep the pairing in a per-machine identity file ([#64](https://github.com/jackhric/decky-toolkit/issues/64)) ([2776937](https://github.com/jackhric/decky-toolkit/commit/27769374f97a2feb2f46b3f19fa33485328e02c6))
* **extension:** show a centered welcome view while no device is saved ([#47](https://github.com/jackhric/decky-toolkit/issues/47)) ([e71d53e](https://github.com/jackhric/decky-toolkit/commit/e71d53e5541126918b018e59443670dfc6763d9f))
* **extension:** write an MCP config that runs the decky-toolkit CLI ([9addb40](https://github.com/jackhric/decky-toolkit/commit/9addb4091ca64ee5cfc38ecbd6fb236c673915d9))
* live sync for plugin development ([#78](https://github.com/jackhric/decky-toolkit/issues/78)) ([f8d3b99](https://github.com/jackhric/decky-toolkit/commit/f8d3b9922a13c876f02bf6a3ea1a3d9a764ecaa4))
* make the screen panel native and drop the browser viewer ([#43](https://github.com/jackhric/decky-toolkit/issues/43)) ([2ffc5bb](https://github.com/jackhric/decky-toolkit/commit/2ffc5bb908992f5cf6683cdc4a27f7ded89b5f8c))
* merge VS Code / VSCodium extension MVP ([bb4a187](https://github.com/jackhric/decky-toolkit/commit/bb4a187b5594a7606703539e0a4fe5a34a0f2d2a))
* pair with mutual TLS and relay MCP through the extension ([#59](https://github.com/jackhric/decky-toolkit/issues/59)) ([3b629bd](https://github.com/jackhric/decky-toolkit/commit/3b629bd3c241b648b2a3b1f924fd3a94af0ab256))
* **pairing:** merge device-approved pairing requests and simplified panel ([2f2f925](https://github.com/jackhric/decky-toolkit/commit/2f2f925d1305d1b39a30c66c6baf0aad9a819556))
* rename and merge the MCP tools into one &lt;area&gt;_&lt;action&gt; scheme ([#81](https://github.com/jackhric/decky-toolkit/issues/81)) ([45ad870](https://github.com/jackhric/decky-toolkit/commit/45ad870abf905b7150a4d7c5df7a18643b1f4750))
* show device versions and remove manual pairing ([#48](https://github.com/jackhric/decky-toolkit/issues/48)) ([ed4665b](https://github.com/jackhric/decky-toolkit/commit/ed4665bfe038edbb0dd115b07ed4c4ee36cc51c3))


### Bug Fixes

* **build:** typecheck and install on Linux with current pnpm ([b085832](https://github.com/jackhric/decky-toolkit/commit/b08583255c3110d040493a3b78f34a8b8be9b8b1))
* **capture:** merge stream watchdog for gamescope renegotiation ([516b792](https://github.com/jackhric/decky-toolkit/commit/516b79295c47749b26952ff004466be24d90f890))
* **capture:** restart the screen pipeline when gamescope's stream wedges ([43ec64c](https://github.com/jackhric/decky-toolkit/commit/43ec64cdf6305dbf49fda5ec8eb74cb4d920e938))
* **extension:** adopt a pairing made by the CLI as the saved device ([ebe3e7c](https://github.com/jackhric/decky-toolkit/commit/ebe3e7c6d16b20c9831fef779b003179e8a44a86))
* **extension:** center the icon on a light tile for dark themes ([#9](https://github.com/jackhric/decky-toolkit/issues/9)) ([50c8652](https://github.com/jackhric/decky-toolkit/commit/50c8652660f74e4fc84c5b289085ffc99e14ccdd))
* **extension:** don't preconfigure a device for new users ([#13](https://github.com/jackhric/decky-toolkit/issues/13)) ([1a66d91](https://github.com/jackhric/decky-toolkit/commit/1a66d9157a7266f69eea9addef9022e1fb689bfe))
* **extension:** give dev-check's proxy a Memento-shaped secret store ([5ada009](https://github.com/jackhric/decky-toolkit/commit/5ada0095f3804cba570d7071ea5821be5b4ecdf7))
* **extension:** replace the screen tab orphaned by an extension host restart ([#51](https://github.com/jackhric/decky-toolkit/issues/51)) ([b17e0b8](https://github.com/jackhric/decky-toolkit/commit/b17e0b8d9f97696181bffb741c89b6b48912c449))
* **extension:** shorten the listing summary ([#21](https://github.com/jackhric/decky-toolkit/issues/21)) ([fbd88e3](https://github.com/jackhric/decky-toolkit/commit/fbd88e3712b48a72856d31ad7ed855db957cc1f3))
* **extension:** stop duplicate MJPEG streams doubling the screen fps readout ([119617b](https://github.com/jackhric/decky-toolkit/commit/119617b2ba89ea8e6d978f390e2ac8019f5eaa72))
* **extension:** use the dev badge as the extension icon ([#2](https://github.com/jackhric/decky-toolkit/issues/2)) ([921f88c](https://github.com/jackhric/decky-toolkit/commit/921f88c0ac8c23d4a980854d729efec28fa587d0))
* **plugins:** swap the plugin dir while the loader is stopped on restart=loader ([c3fbca1](https://github.com/jackhric/decky-toolkit/commit/c3fbca1685971e8ec9722637fb3b3c3196eb1f80))
* point repository URLs at jackhric/decky-toolkit ([632a1d8](https://github.com/jackhric/decky-toolkit/commit/632a1d8264b8dc432c4a0cebd9416e0130f77ad3))

## [0.8.0](https://github.com/jackhric/decky-toolkit/compare/extension-v0.7.0...extension-v0.8.0) (2026-11-06)


### ⚠ BREAKING CHANGES

* rename and merge the MCP tools into one <area>_<action> scheme ([#81](https://github.com/jackhric/decky-toolkit/issues/81))

### Features

* live sync for plugin development ([#78](https://github.com/jackhric/decky-toolkit/issues/78)) ([f8d3b99](https://github.com/jackhric/decky-toolkit/commit/f8d3b9922a13c876f02bf6a3ea1a3d9a764ecaa4))
* rename and merge the MCP tools into one &lt;area&gt;_&lt;action&gt; scheme ([#81](https://github.com/jackhric/decky-toolkit/issues/81)) ([45ad870](https://github.com/jackhric/decky-toolkit/commit/45ad870abf905b7150a4d7c5df7a18643b1f4750))


### Bug Fixes

* **extension:** adopt a pairing made by the CLI as the saved device ([ebe3e7c](https://github.com/jackhric/decky-toolkit/commit/ebe3e7c6d16b20c9831fef779b003179e8a44a86))

## [0.7.0](https://github.com/jackhric/decky-toolkit/compare/extension-v0.6.4...extension-v0.7.0) (2026-11-06)


### ⚠ BREAKING CHANGES

* pair with mutual TLS and relay MCP through the extension ([#59](https://github.com/jackhric/decky-toolkit/issues/59))
* show device versions and remove manual pairing ([#48](https://github.com/jackhric/decky-toolkit/issues/48))
* make the screen panel native and drop the browser viewer ([#43](https://github.com/jackhric/decky-toolkit/issues/43))

### Features

* add game files, recording, perf overlay, console and UI query tools with a Games view ([#42](https://github.com/jackhric/decky-toolkit/issues/42)) ([97c3170](https://github.com/jackhric/decky-toolkit/commit/97c3170d5332704cdfaff2a8b58e8731d4c30128))
* discover Decky Toolkit devices on the local network ([#45](https://github.com/jackhric/decky-toolkit/issues/45)) ([42e8c0b](https://github.com/jackhric/decky-toolkit/commit/42e8c0b9dc40dfb784366432545c9c300391e398))
* **extension:** add an HTTPS transport that pins the device and presents the client identity ([e8795f8](https://github.com/jackhric/decky-toolkit/commit/e8795f8073c24e5cdb5fb79ee87cb266ae2e4c5a))
* **extension:** keep windows open and show a lost connection state ([#46](https://github.com/jackhric/decky-toolkit/issues/46)) ([fec17f2](https://github.com/jackhric/decky-toolkit/commit/fec17f29800873ced4650b27bfb6198a1bb28169))
* **extension:** pair with a client key and relay MCP through a stable loopback proxy ([1d6885f](https://github.com/jackhric/decky-toolkit/commit/1d6885f642e495668ea815fcd5d078594de41b1a))
* **extension:** share the device client and keep the pairing in a per-machine identity file ([#64](https://github.com/jackhric/decky-toolkit/issues/64)) ([2776937](https://github.com/jackhric/decky-toolkit/commit/27769374f97a2feb2f46b3f19fa33485328e02c6))
* **extension:** show a centered welcome view while no device is saved ([#47](https://github.com/jackhric/decky-toolkit/issues/47)) ([e71d53e](https://github.com/jackhric/decky-toolkit/commit/e71d53e5541126918b018e59443670dfc6763d9f))
* **extension:** write an MCP config that runs the decky-toolkit CLI ([9addb40](https://github.com/jackhric/decky-toolkit/commit/9addb4091ca64ee5cfc38ecbd6fb236c673915d9))
* make the screen panel native and drop the browser viewer ([#43](https://github.com/jackhric/decky-toolkit/issues/43)) ([2ffc5bb](https://github.com/jackhric/decky-toolkit/commit/2ffc5bb908992f5cf6683cdc4a27f7ded89b5f8c))
* pair with mutual TLS and relay MCP through the extension ([#59](https://github.com/jackhric/decky-toolkit/issues/59)) ([3b629bd](https://github.com/jackhric/decky-toolkit/commit/3b629bd3c241b648b2a3b1f924fd3a94af0ab256))
* show device versions and remove manual pairing ([#48](https://github.com/jackhric/decky-toolkit/issues/48)) ([ed4665b](https://github.com/jackhric/decky-toolkit/commit/ed4665bfe038edbb0dd115b07ed4c4ee36cc51c3))


### Bug Fixes

* **extension:** give dev-check's proxy a Memento-shaped secret store ([5ada009](https://github.com/jackhric/decky-toolkit/commit/5ada0095f3804cba570d7071ea5821be5b4ecdf7))
* **extension:** replace the screen tab orphaned by an extension host restart ([#51](https://github.com/jackhric/decky-toolkit/issues/51)) ([b17e0b8](https://github.com/jackhric/decky-toolkit/commit/b17e0b8d9f97696181bffb741c89b6b48912c449))

## [0.6.4](https://github.com/jackhric/decky-toolkit/compare/extension-v0.6.3...extension-v0.6.4) (2026-11-04)


### Bug Fixes

* **extension:** shorten the listing summary ([#21](https://github.com/jackhric/decky-toolkit/issues/21)) ([fbd88e3](https://github.com/jackhric/decky-toolkit/commit/fbd88e3712b48a72856d31ad7ed855db957cc1f3))

## [0.6.3](https://github.com/jackhric/decky-toolkit/compare/extension-v0.6.2...extension-v0.6.3) (2026-11-04)


### Bug Fixes

* **extension:** don't preconfigure a device for new users ([#13](https://github.com/jackhric/decky-toolkit/issues/13)) ([1a66d91](https://github.com/jackhric/decky-toolkit/commit/1a66d9157a7266f69eea9addef9022e1fb689bfe))

## [0.6.2](https://github.com/jackhric/decky-toolkit/compare/extension-v0.6.1...extension-v0.6.2) (2026-11-04)


### Bug Fixes

* **extension:** center the icon on a light tile for dark themes ([#9](https://github.com/jackhric/decky-toolkit/issues/9)) ([50c8652](https://github.com/jackhric/decky-toolkit/commit/50c8652660f74e4fc84c5b289085ffc99e14ccdd))

## [0.6.1](https://github.com/jackhric/decky-toolkit/compare/extension-v0.6.0...extension-v0.6.1) (2026-11-04)


### Bug Fixes

* **extension:** use the dev badge as the extension icon ([#2](https://github.com/jackhric/decky-toolkit/issues/2)) ([921f88c](https://github.com/jackhric/decky-toolkit/commit/921f88c0ac8c23d4a980854d729efec28fa587d0))
