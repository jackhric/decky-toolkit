---
title: Give agents your plugin's own tools
description: Register MCP tools from your Decky plugin's frontend so coding agents can call into your plugin directly.
sidebar:
  order: 5
---

Your plugin can offer its own tools to the agents connected to the device: "clear the cache", "show the state of the
sync", "open the settings for this game". The agent sees them next to Decky Toolkit's tools and calls them like any
other. They run in your plugin's frontend, so they can use everything your UI uses, including your backend through
`callable`.

## Add a tool

Install the helper and a schema library ([Zod](https://zod.dev) 4.2 or newer here; ArkType and Valibot work too):

```sh
pnpm add decky-toolkit zod
```

Create `src/tools.ts`:

```ts
import { registerTool } from "decky-toolkit/tools";
import { callable } from "@decky/api";
import { z } from "zod";

const resetCache = callable<[appid?: number], number>("reset_cache");

export function registerTools() {
  registerTool({
    name: "reset_cache",
    description: "Clear cached artwork and reload the library view.",
    inputSchema: z.object({ appid: z.number().int().optional() }),
    execute: async ({ appid }) => ({ cleared: await resetCache(appid) }),
  });
}
```

Call `registerTools()` inside `definePlugin` in `src/index.tsx`. A bare `import "./tools";` is not enough with the
template's Rollup build: it removes modules that are only imported for their side effects.

A new plugin made with **New plugin…** (or `decky-toolkit new --variant mcp-tool`) starts with a working example.

Deploy the plugin. If its folder on the device is `my-plugin`, agents now see `my_plugin_reset_cache`.

That is all. There is no plugin name to pass and nothing to clean up: when your plugin reloads or unloads, its tools
go away, and the tools of the new version appear. Agents get a "tool list changed" notice either way.

## What you write

`registerTool(tool, { signal })` follows the [WebMCP](https://webmachinelearning.github.io/webmcp/) draft:

| Field | |
| --- | --- |
| `name` | Lowercase letters, digits and `_`. Agents see `<plugin folder>_<name>`. |
| `description` | What the tool does and when to use it. Agents choose tools by it. |
| `inputSchema` | The arguments, as an object schema. Leave it out for a tool without arguments. |
| `outputSchema` | Optional. Describes and checks what `execute` returns. |
| `annotations` | Optional hints: `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`. |
| `execute(input, { signal })` | Runs the tool. Return any JSON value; strings are shown as they are. Throw to report an error. |

The schema does three jobs: it is the argument list the agent sees, it checks the arguments before `execute` runs
(an agent that sends a wrong value gets your schema's message back), and it gives `input` its TypeScript type. A
default in the schema (`z.number().default(1)`) is applied before `execute`.

You can also pass a plain JSON Schema object as `inputSchema`. Then the device only checks for unknown and missing
arguments, and `input` is typed loosely.

`signal` aborts when the agent cancels the call or the call times out. Pass `{ signal }` as the second argument to
`registerTool` to remove a tool early, for example while a feature is turned off:

```ts
const off = new AbortController();
registerTool(tool, { signal: off.signal });
off.abort(); // gone
```

## Type checks

TypeScript checks a tool while you write it:

- `input` has the type of the schema's output, so a misspelled argument or a wrong type is a compile error.
- With `outputSchema`, the return value must match it.
- A literal `name` with capitals or `-` is a compile error that says what is allowed.

## When something goes wrong

- `registerTool` rejects on an invalid name or schema, or a name your plugin already registered. Unawaited, that
  shows up in the Steam console (`logs_read` with `source: "steam_console"`).
- An error thrown in `execute` reaches the agent with its stack, mapped to your `src/` files when the plugin ships its
  source map (`dist/index.js.map`, as the template's build does).
- A tool that cannot be offered (bad name, a folder name that gives the same prefix as a Decky Toolkit area such as
  `screen` or `ui`, a name longer than 64 characters, or a clash with another plugin) is listed with the reason under
  `mcp_tools.refused` in `plugin_list`, and in Decky Toolkit's log.
- Without Decky Toolkit on the device, `registerTool` does nothing harmful: the tool is kept in the page and never
  called.

The helper has no dependencies.
