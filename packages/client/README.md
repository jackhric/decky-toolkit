# Decky Toolkit client

TypeScript source of the device client (transport, API types, discovery, pairing, identity file, plugin staging and deploy, MCP config entry): plain Node, no `vscode`.
Consumed by bundling: the VS Code extension and the CLI import it as `@decky-toolkit/client/*` and esbuild inlines it.
Not published; it has no package.json of its own.
