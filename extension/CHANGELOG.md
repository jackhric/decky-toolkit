# Changelog

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
