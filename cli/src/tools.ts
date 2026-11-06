// `decky-toolkit/tools`: MCP tools defined by a Decky plugin's frontend, modelled on WebMCP's registerTool
// (https://webmachinelearning.github.io/webmcp/). Bundled into each plugin, so it has no runtime dependencies and
// every copy, whatever its version, must keep speaking the v1 registry contract below.

/** Standard Schema v1 (https://standardschema.dev), the parts used here. */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': StandardSchemaV1.Props<Input, Output>;
}
export declare namespace StandardSchemaV1 {
  interface Props<Input = unknown, Output = Input> {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => Result<Output> | Promise<Result<Output>>;
    readonly types?: { readonly input: Input; readonly output: Output } | undefined;
  }
  type Result<Output> = { readonly value: Output; readonly issues?: undefined } | { readonly issues: ReadonlyArray<Issue> };
  interface Issue {
    readonly message: string;
    readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined;
  }
}

/** Standard JSON Schema v1 (https://standardschema.dev/json-schema), the parts used here. */
export interface StandardJSONSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': StandardJSONSchemaV1.Props<Input, Output>;
}
export declare namespace StandardJSONSchemaV1 {
  interface Props<Input = unknown, Output = Input> {
    readonly version: 1;
    readonly vendor: string;
    readonly types?: { readonly input: Input; readonly output: Output } | undefined;
    readonly jsonSchema: {
      readonly input: (options: { readonly target: string }) => Record<string, unknown>;
      readonly output: (options: { readonly target: string }) => Record<string, unknown>;
    };
  }
}

/** A schema from Zod (>= 4.2), ArkType (>= 2.1.28), Valibot (through `toStandardJsonSchema`) or any other library
 *  implementing both Standard Schema and Standard JSON Schema. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type StandardSchemaWithJSON<Input = any, Output = Input> = StandardSchemaV1<Input, Output> & StandardJSONSchemaV1<Input, Output>;

/** A plain JSON Schema for an object. Arguments are then not validated in the page and typed loosely. */
export interface JSONSchemaObject {
  readonly type: 'object';
  readonly properties?: Readonly<Record<string, object>>;
  readonly required?: readonly string[];
  readonly [keyword: string]: unknown;
}

export type ToolSchema = StandardSchemaWithJSON | JSONSchemaObject;

/** MCP tool annotations: hints for the agent, not enforced. */
export interface ToolAnnotations {
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
}

type Infer<S, Side extends 'input' | 'output'> = S extends { readonly '~standard': { readonly types?: infer T } }
  ? NonNullable<T> extends { readonly input: unknown; readonly output: unknown } ? NonNullable<T>[Side] : unknown
  : S extends JSONSchemaObject ? Record<string, unknown> : Record<string, never>;

/** What `execute` receives: the schema's validated output. */
export type ToolInput<S extends ToolSchema | undefined> = Infer<S, 'output'>;
/** What `execute` returns: whatever the output schema accepts, any JSON value without one. */
export type ToolResult<S extends ToolSchema | undefined> = S extends ToolSchema ? Infer<S, 'input'> : unknown;

type NameChar = 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g' | 'h' | 'i' | 'j' | 'k' | 'l' | 'm' | 'n' | 'o' | 'p' | 'q' | 'r'
  | 's' | 't' | 'u' | 'v' | 'w' | 'x' | 'y' | 'z' | '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '_';
type OnlyNameChars<S extends string> = S extends `${infer C}${infer Rest}` ? C extends NameChar ? OnlyNameChars<Rest> : false : true;
/** A literal name must be lowercase letters, digits and `_`; the error spells out the rule. */
export type ToolName<N extends string> = string extends N ? N
  : N extends '' ? 'a tool name cannot be empty'
  : OnlyNameChars<N> extends true ? N : `invalid tool name "${N}": use lowercase letters, digits and _`;

export interface Tool<N extends string, I extends ToolSchema | undefined, O extends ToolSchema | undefined> {
  /** Agents see it as `<plugin directory>_<name>`, e.g. `my_plugin_reset_cache`. */
  readonly name: ToolName<N>;
  readonly title?: string;
  readonly description: string;
  /** Omit for a tool without arguments. */
  readonly inputSchema?: I;
  readonly outputSchema?: O;
  readonly annotations?: ToolAnnotations;
  /** `signal` aborts when the agent's call is cancelled or times out. */
  execute(input: ToolInput<I>, options: { readonly signal: AbortSignal }): ToolResult<O> | Promise<ToolResult<O>>;
}

export interface RegisterToolOptions {
  /** Aborting it removes the tool. Tools are also removed when the plugin unloads or reloads. */
  readonly signal?: AbortSignal;
}

/** v1 registry contract, shared on `window` by every plugin's copy of this module and read by Decky Toolkit. */
interface Registration {
  readonly plugin: string;
  /** The bundle URL of the plugin load that registered it; Decky adds `?t=<time>`, so each load differs. */
  readonly url: string;
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: object;
  readonly outputSchema?: object;
  readonly annotations?: ToolAnnotations;
  /** Validates the arguments, then runs `execute`; `invalid` explains arguments the schema refused. */
  call(input: unknown, signal: AbortSignal): Promise<{ value: unknown } | { invalid: string }>;
}
interface Registry {
  readonly version: 1;
  readonly tools: Set<Registration>;
}

const REGISTRY = '__deckyToolkitTools';
// A DevTools binding Decky Toolkit installs; absent on a device without it.
const CHANGED = '__deckyToolkitToolsChanged';
const NAME = /^[a-z0-9_]+$/;
const NO_ARGUMENTS = { type: 'object', properties: {}, additionalProperties: false };

const host = globalThis as unknown as Record<string, unknown>;

function registry(): Registry {
  return (host[REGISTRY] ??= { version: 1, tools: new Set() }) as Registry;
}

function changed(): void {
  const notify = host[CHANGED];
  if (typeof notify === 'function') notify('');
}

/** The calling plugin, from the URL Decky imported its bundle from (this code is bundled into it). */
function callingPlugin(stack: string): { plugin: string; url: string } {
  const m = /(https?:\/\/[^\s()]+?\/plugins\/([^/\s()]+)\/dist\/[^\s():?]+(?:\?[^\s():]*)?)/.exec(stack);
  if (!m) throw new Error('registerTool must run in a Decky plugin\'s frontend (its dist/index.js)');
  return { plugin: decodeURIComponent(m[2]), url: m[1] };
}

function isStandard(schema: ToolSchema): schema is StandardSchemaWithJSON {
  return '~standard' in schema;
}

function jsonSchema(schema: ToolSchema, side: 'input' | 'output', field: string): object {
  let json: unknown = schema;
  if (isStandard(schema)) {
    const std = schema['~standard'];
    if (typeof std.jsonSchema?.[side] !== 'function') {
      throw new TypeError(`${field}: this ${std.vendor} schema cannot export JSON Schema (it needs Standard JSON Schema support)`);
    }
    json = std.jsonSchema[side]({ target: 'draft-2020-12' });
  }
  if (!json || typeof json !== 'object' || (json as { type?: unknown }).type !== 'object') {
    throw new TypeError(`${field} must describe an object`);
  }
  return JSON.parse(JSON.stringify(json));
}

function issueText(issue: StandardSchemaV1.Issue): string {
  const path = (issue.path ?? []).map(p => String(typeof p === 'object' ? p.key : p)).join('.');
  return path ? `${path}: ${issue.message}` : issue.message;
}

async function validate(schema: ToolSchema | undefined, value: unknown): Promise<{ value: unknown } | { invalid: string }> {
  if (!schema || !isStandard(schema)) return { value };
  const r = await schema['~standard'].validate(value);
  return r.issues ? { invalid: r.issues.map(issueText).join('; ') } : { value: r.value };
}

/**
 * Offers a tool to the agents connected to this device through Decky Toolkit. Call it at the top level of a module
 * your plugin imports; the tool lives until the plugin unloads or reloads, or until `options.signal` aborts.
 * Rejects (like WebMCP's `registerTool`) on an invalid name or schema, or a name this plugin load already registered.
 */
export async function registerTool<const N extends string, I extends ToolSchema | undefined = undefined,
  O extends ToolSchema | undefined = undefined>(tool: Tool<N, I, O>, options: RegisterToolOptions = {}): Promise<void> {
  const { plugin, url } = callingPlugin(new Error().stack ?? '');
  const { name, title, description, inputSchema, outputSchema, annotations, execute } = tool as unknown as Tool<string, ToolSchema | undefined, ToolSchema | undefined>;
  if (typeof name !== 'string' || !NAME.test(name)) throw new TypeError(`invalid tool name ${JSON.stringify(name)}: use lowercase letters, digits and _`);
  if (typeof description !== 'string' || !description.trim()) throw new TypeError(`${name}: description must not be empty`);
  if (typeof execute !== 'function') throw new TypeError(`${name}: execute must be a function`);
  options.signal?.throwIfAborted();
  const tools = registry().tools;
  for (const t of tools) {
    if (t.url === url && t.name === name) throw new Error(`${name} is already registered by this plugin`);
  }
  const registration: Registration = {
    plugin, url, name, title, description, annotations,
    inputSchema: inputSchema ? jsonSchema(inputSchema, 'input', `${name}: inputSchema`) : NO_ARGUMENTS,
    outputSchema: outputSchema && jsonSchema(outputSchema, 'output', `${name}: outputSchema`),
    // Named so Decky Toolkit can cut the stacks it reports at this frame (unless a minifier renamed it).
    call: async function deckyToolkitCall(input, signal) {
      const args = await validate(inputSchema, input ?? {});
      if ('invalid' in args) return args;
      const result = await validate(outputSchema, await execute(args.value as never, { signal }));
      if ('invalid' in result) throw new TypeError(`${name} returned a result its outputSchema refuses: ${result.invalid}`);
      return result;
    },
  };
  tools.add(registration);
  options.signal?.addEventListener('abort', () => {
    if (tools.delete(registration)) changed();
  }, { once: true });
  changed();
}
