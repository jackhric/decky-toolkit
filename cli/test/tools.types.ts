// Compile-time checks of `decky-toolkit/tools`; part of `pnpm run typecheck`, never run.
import { z } from 'zod';
import { registerTool } from '../src/tools';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const expect = <T extends true>(_: T) => {};

void registerTool({
  name: 'reset_cache',
  description: 'Clear cached artwork.',
  inputSchema: z.object({ appid: z.number().int().optional(), mode: z.enum(['soft', 'hard']).default('soft') }),
  execute: async (input) => {
    // The schema's output: defaults applied, so mode is never undefined.
    expect<Equal<typeof input, { appid?: number | undefined; mode: 'soft' | 'hard' }>>(true);
    return { cleared: 3 };
  },
});

void registerTool({
  name: 'no_arguments',
  description: 'Takes nothing.',
  execute: (input) => {
    expect<Equal<typeof input, Record<string, never>>>(true);
    return 'ok';
  },
});

void registerTool({
  name: 'plain_json_schema',
  description: 'Loosely typed input.',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  execute: (input) => {
    expect<Equal<typeof input, Record<string, unknown>>>(true);
    return String(input.path);
  },
});

void registerTool({
  name: 'typed_result',
  description: 'Returns what outputSchema describes.',
  outputSchema: z.object({ count: z.number() }),
  execute: async () => ({ count: 1 }),
});

void registerTool({
  name: 'aborts',
  description: 'Gets a signal.',
  execute: async (_input, { signal }) => {
    expect<Equal<typeof signal, AbortSignal>>(true);
  },
}, { signal: new AbortController().signal });

const dynamicName: string = 'from_somewhere';
void registerTool({ name: dynamicName, description: 'Checked at runtime only.', execute: () => null });

void registerTool({
  // @ts-expect-error -- names are lowercase letters, digits and _
  name: 'Reset-Cache',
  description: 'Bad name.',
  execute: () => null,
});

// @ts-expect-error -- an empty name
void registerTool({ name: '', description: 'Empty name.', execute: () => null });

void registerTool({
  name: 'wrong_input_use',
  description: 'Input is typed from the schema.',
  inputSchema: z.object({ appid: z.number() }),
  // @ts-expect-error -- appid is a number
  execute: ({ appid }) => appid.toUpperCase(),
});

void registerTool({
  name: 'wrong_result',
  description: 'Result checked against outputSchema.',
  outputSchema: z.object({ count: z.number() }),
  // @ts-expect-error -- count must be a number
  execute: async () => ({ count: 'one' }),
});

void registerTool({
  name: 'not_an_object',
  description: 'Input schemas describe an object.',
  // @ts-expect-error -- a plain JSON Schema must have type 'object'
  inputSchema: { type: 'string' },
  execute: () => null,
});

void registerTool({
  name: 'unknown_annotation',
  description: 'Only MCP annotations.',
  // @ts-expect-error -- not an MCP annotation
  annotations: { dangerous: true },
  execute: () => null,
});
