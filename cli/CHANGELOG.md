# Changelog

## [0.6.0](https://github.com/jackhric/decky-toolkit/compare/cli-v0.5.0...cli-v0.6.0) (2026-11-07)


### ⚠ BREAKING CHANGES

* POST /api/v1/plugins/{dir}/reload?mode= is now POST /api/v1/plugins/reload with JSON {plugin, mode}, where plugin is the plugin.json name; plugin_reload takes only the name.

### Features

* **cli:** build before deploy, one deploy path with the extension ([#101](https://github.com/jackhric/decky-toolkit/issues/101)) ([c21632a](https://github.com/jackhric/decky-toolkit/commit/c21632a61691fe5b0a9516e8c46297f31f6b1054))


### Bug Fixes

* reload plugins by their plugin.json name ([#109](https://github.com/jackhric/decky-toolkit/issues/109)) ([a8d73e8](https://github.com/jackhric/decky-toolkit/commit/a8d73e8f44455fc3b4409ccda4815b9c4d656f51))

## [0.5.0](https://github.com/jackhric/decky-toolkit/compare/cli-v0.4.0...cli-v0.5.0) (2026-11-06)


### ⚠ BREAKING CHANGES

* versioned client API under /api/v1, trimmed routes ([#89](https://github.com/jackhric/decky-toolkit/issues/89))

### Features

* push device changes to clients over /api/v1/events ([#90](https://github.com/jackhric/decky-toolkit/issues/90)) ([9578ea8](https://github.com/jackhric/decky-toolkit/commit/9578ea8d0c25a735bc6ab47868660b989acaa3c3))
* tell agents where the Steam UI is before and after they act ([dee2b51](https://github.com/jackhric/decky-toolkit/commit/dee2b51d1bc4393c64ecdad97c909078eef0a3a8))
* versioned client API under /api/v1, trimmed routes ([#89](https://github.com/jackhric/decky-toolkit/issues/89)) ([4da45cb](https://github.com/jackhric/decky-toolkit/commit/4da45cb898d516e13f87c2e95ed6ac65095f8ce0))

## [0.4.0](https://github.com/jackhric/decky-toolkit/compare/cli-v0.3.0...cli-v0.4.0) (2026-11-06)


### ⚠ BREAKING CHANGES

* rename and merge the MCP tools into one <area>_<action> scheme ([#81](https://github.com/jackhric/decky-toolkit/issues/81))

### Features

* **cli:** add the decky-toolkit CLI with pair, status, mcp, deploy, call and forget ([8b47e79](https://github.com/jackhric/decky-toolkit/commit/8b47e79bf2bcf424cd036a7e7f6fe68f3d94ce8b))
* keep agents' tool lists current, refuse unknown arguments, add backend stack dumps ([#79](https://github.com/jackhric/decky-toolkit/issues/79)) ([f884efb](https://github.com/jackhric/decky-toolkit/commit/f884efbc1d02cb8b65191a823b2114a6d8f5ade5))
* live sync for plugin development ([#78](https://github.com/jackhric/decky-toolkit/issues/78)) ([f8d3b99](https://github.com/jackhric/decky-toolkit/commit/f8d3b9922a13c876f02bf6a3ea1a3d9a764ecaa4))
* rename and merge the MCP tools into one &lt;area&gt;_&lt;action&gt; scheme ([#81](https://github.com/jackhric/decky-toolkit/issues/81)) ([45ad870](https://github.com/jackhric/decky-toolkit/commit/45ad870abf905b7150a4d7c5df7a18643b1f4750))

## [0.3.0](https://github.com/jackhric/decky-toolkit/compare/cli-v0.2.0...cli-v0.3.0) (2026-11-06)


### ⚠ BREAKING CHANGES

* rename and merge the MCP tools into one <area>_<action> scheme ([#81](https://github.com/jackhric/decky-toolkit/issues/81))

### Features

* **cli:** add the decky-toolkit CLI with pair, status, mcp, deploy, call and forget ([8b47e79](https://github.com/jackhric/decky-toolkit/commit/8b47e79bf2bcf424cd036a7e7f6fe68f3d94ce8b))
* keep agents' tool lists current, refuse unknown arguments, add backend stack dumps ([#79](https://github.com/jackhric/decky-toolkit/issues/79)) ([f884efb](https://github.com/jackhric/decky-toolkit/commit/f884efbc1d02cb8b65191a823b2114a6d8f5ade5))
* live sync for plugin development ([#78](https://github.com/jackhric/decky-toolkit/issues/78)) ([f8d3b99](https://github.com/jackhric/decky-toolkit/commit/f8d3b9922a13c876f02bf6a3ea1a3d9a764ecaa4))
* rename and merge the MCP tools into one &lt;area&gt;_&lt;action&gt; scheme ([#81](https://github.com/jackhric/decky-toolkit/issues/81)) ([45ad870](https://github.com/jackhric/decky-toolkit/commit/45ad870abf905b7150a4d7c5df7a18643b1f4750))

## [0.2.0](https://github.com/jackhric/decky-toolkit/compare/cli-v0.1.0...cli-v0.2.0) (2026-11-06)


### ⚠ BREAKING CHANGES

* rename and merge the MCP tools into one <area>_<action> scheme ([#81](https://github.com/jackhric/decky-toolkit/issues/81))

### Features

* keep agents' tool lists current, refuse unknown arguments, add backend stack dumps ([#79](https://github.com/jackhric/decky-toolkit/issues/79)) ([f884efb](https://github.com/jackhric/decky-toolkit/commit/f884efbc1d02cb8b65191a823b2114a6d8f5ade5))
* live sync for plugin development ([#78](https://github.com/jackhric/decky-toolkit/issues/78)) ([f8d3b99](https://github.com/jackhric/decky-toolkit/commit/f8d3b9922a13c876f02bf6a3ea1a3d9a764ecaa4))
* rename and merge the MCP tools into one &lt;area&gt;_&lt;action&gt; scheme ([#81](https://github.com/jackhric/decky-toolkit/issues/81)) ([45ad870](https://github.com/jackhric/decky-toolkit/commit/45ad870abf905b7150a4d7c5df7a18643b1f4750))

## [0.1.0](https://github.com/jackhric/decky-toolkit/compare/cli-v0.0.1...cli-v0.1.0) (2026-11-06)


### Features

* **cli:** add the decky-toolkit CLI with pair, status, mcp, deploy, call and forget ([8b47e79](https://github.com/jackhric/decky-toolkit/commit/8b47e79bf2bcf424cd036a7e7f6fe68f3d94ce8b))
