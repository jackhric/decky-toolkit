import { once } from 'events';
import * as readline from 'readline';
import type { Readable, Writable } from 'stream';
import type { ToolCallResult, ToolDescription } from '@decky-toolkit/client/api';
import type { DeckyClient, EventSubscription } from '@decky-toolkit/client/client';
import * as identityFile from '@decky-toolkit/client/identity';
import {
  InvalidOption, NotPairedError, PAIR_HINT, Paired, RESTART_MODES, deploy, deviceStatus, explain, onDevice, pairedWith, parseRestart,
} from './device';
import { VERSION } from './version';

export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const LOCAL_TOOLS: ToolDescription[] = [
  {
    name: 'plugin_deploy',
    description: 'Package a Decky plugin folder (plugin.json, dist/, main.py, py_modules/, ...) from this machine, install it on the paired device '
      + 'and confirm the device loaded it. Run the plugin\'s own build first; dist/ must exist. Without `restart`, a new plugin restarts '
      + 'Decky Loader, a plugin with the debug flag is left to the loader\'s file watcher, and any other installed one is reloaded.',
    inputSchema: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: 'Plugin folder on this machine; relative paths start at the working directory. Default: the working directory.' },
        restart: { type: 'string', enum: RESTART_MODES, description: 'none: only swap the files (a plugin with the debug flag is still reloaded by the loader\'s file watcher); plugin: reload this plugin; loader: restart Decky Loader.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'device_status',
    description: 'Which device this machine is paired with, whether it answers, whether it still accepts the pairing, and the Decky Toolkit version and tool count it reports.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

type Id = string | number | null;
type Message = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };

const text = (t: string, isError = false): ToolCallResult => ({ content: [{ type: 'text', text: t }], isError });
const result = (id: Id, value: unknown) => JSON.stringify({ jsonrpc: '2.0', id, result: value });
const failure = (id: Id, code: number, message: string) => JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });

class InvalidParams extends Error {}

/** Only while the event stream is down; otherwise its `tools` events report changes as they happen. */
const TOOLS_CHECK_MS = 15000;
const INSTRUCTIONS_TIMEOUT_MS = 1500;

/** Unknown arguments are refused, as on the device, so a misspelt one never silently falls back to a default. */
function argumentProblem(tool: ToolDescription, args: Record<string, unknown>): string | undefined {
  const props = (tool.inputSchema as { properties?: Record<string, { enum?: unknown[]; type?: string }> }).properties ?? {};
  const unknown = Object.keys(args).filter(k => !(k in props));
  if (!unknown.length) return undefined;
  const list = Object.entries(props).map(([k, v]) => `${k} (${v.enum ? v.enum.join('|') : v.type ?? 'any'})`).join('; ');
  return `Invalid arguments for ${tool.name}: unknown argument${unknown.length > 1 ? 's' : ''} ${unknown.map(k => `'${k}'`).join(', ')}. `
    + (list ? `Arguments: ${list}.` : 'It takes no arguments.');
}

/** The device was asked with the client's id, so its reply line is ours as it stands once the envelope checks out. */
function relay(id: Id, tool: string, body: string): string {
  let msg: { jsonrpc?: unknown; id?: unknown; result?: unknown; error?: { message?: unknown } } | null;
  try {
    msg = JSON.parse(body);
  } catch {
    return result(id, text(`${tool}: the device answered with something that is not JSON`, true));
  }
  if (msg?.error) return result(id, text(`${tool}: tools/call: ${msg.error.message}`, true));
  if (msg?.jsonrpc !== '2.0' || msg.id !== id || !msg.result || typeof msg.result !== 'object') {
    return result(id, text(`${tool}: the device answered with a malformed reply`, true));
  }
  const line = body.trim();
  // stdio framing is one message per line.
  return line.includes('\n') ? result(id, msg.result) : line;
}

export class McpServer {
  private deviceTools?: { key: string; tools: Promise<ToolDescription[]> };
  /** Read on first use, then replaced by `serve`'s watch of the identity file. */
  private paired?: Promise<Paired | null>;
  /** The device's tool fingerprint when the client last got the list; unset until a list was served. */
  private listedKey?: string;
  private checking?: Promise<void>;
  /** Set by `serve`; sends a notification line to the client. */
  private notify?: (line: string) => void;
  private events?: EventSubscription;
  /** Bumped per `follow` so a subscription for a previous pairing is not kept. */
  private followGen = 0;
  /** Between a `hello` and the next drop of the event stream. */
  private streamUp = false;

  constructor(private readonly log: (line: string) => void) {}

  private readonly current = async (): Promise<Paired> => {
    this.paired ??= identityFile.read().then(f => f && pairedWith(f));
    const p = await this.paired;
    if (!p) throw new NotPairedError();
    return p;
  };

  /** The device's list, fetched once per device per process; a failed fetch is retried on the next request. */
  private toolsOf(client: DeckyClient): Promise<ToolDescription[]> {
    const key = `${client.address.host}:${client.address.port}`;
    if (this.deviceTools?.key !== key) {
      const tools = client.listTools();
      this.deviceTools = { key, tools };
      tools.catch(() => { if (this.deviceTools?.tools === tools) this.deviceTools = undefined; });
    }
    return this.deviceTools.tools;
  }

  private async listTools(): Promise<ToolDescription[]> {
    const local = new Set(LOCAL_TOOLS.map(t => t.name));
    const r = await onDevice(this.current, async p => {
      const [tools, health] = await Promise.all([this.toolsOf(p.client), p.client.health().catch(() => undefined)]);
      this.listedKey = health?.tools_hash ?? '?';
      return tools;
    });
    if ('value' in r) return [...r.value.filter(t => !local.has(t.name)), ...LOCAL_TOOLS];
    this.log(`decky-toolkit: device tools unavailable: ${r.error}`);
    return LOCAL_TOOLS;
  }

  private async callTool(id: Id, params: Record<string, unknown>): Promise<string> {
    const name = params.name;
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (typeof name !== 'string') throw new InvalidParams('tools/call needs a tool name');
    if (typeof args !== 'object' || Array.isArray(args)) throw new InvalidParams('tools/call arguments must be an object');
    const localTool = LOCAL_TOOLS.find(t => t.name === name);
    const problem = localTool && argumentProblem(localTool, args);
    if (problem) return result(id, text(problem, true));
    if (name === 'device_status') return result(id, text(JSON.stringify(await deviceStatus(), null, 2)));
    if (name === 'plugin_deploy') {
      try {
        const dir = args.dir ?? '.';
        if (typeof dir !== 'string') throw new InvalidOption('dir must be a string');
        return result(id, text(JSON.stringify(await deploy(dir, parseRestart(args.restart), this.log), null, 2)));
      } catch (e) {
        return result(id, text(e instanceof InvalidOption ? e.message : `deploy failed: ${explain(e)}`, true));
      }
    }
    const r = await onDevice(this.current, p => p.client.rpcText('tools/call', { name, arguments: args }, 300000, id));
    // A call may have changed the device's tools (a deploy of Decky Toolkit itself); without events, look once it is answered.
    setTimeout(() => void this.checkTools(), 0);
    return 'error' in r ? result(id, text(`${name}: ${r.error}`, true)) : relay(id, name, r.value);
  }

  /** Tells the client to fetch the list again once the device's tools differ from the ones it got. */
  private toolsChanged(hash: string | undefined): void {
    if (this.listedKey === undefined || hash === this.listedKey) return;
    this.deviceTools = undefined;
    this.listedKey = undefined;
    this.notify?.(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }));
  }

  /** Asks `/health` for the tools hash; a no-op while the event stream is up unless `force`d (another pairing). */
  checkTools(force = false): Promise<void> {
    this.checking ??= (async () => {
      try {
        if (this.listedKey === undefined || (!force && this.streamUp)) return;
        if (force) return this.toolsChanged(undefined);
        const p = await this.current().catch(() => undefined);
        const h = await p?.client.health().catch(() => undefined);
        if (h) this.toolsChanged(h.tools_hash);
      } finally {
        this.checking = undefined;
      }
    })();
    return this.checking;
  }

  /** Follows the paired device's events: `tools` carries the hash, so a change is announced as soon as it happens. */
  private follow(): void {
    const gen = ++this.followGen;
    this.events?.close();
    this.events = undefined;
    this.streamUp = false;
    void this.current().then(p => {
      if (gen !== this.followGen) return;
      this.events = p.client.events({
        onEvent: e => {
          if (e.event === 'hello') this.streamUp = true;
          else if (e.event === 'tools') this.toolsChanged(e.data.hash);
        },
        onDown: () => {
          this.streamUp = false;
        },
      });
    }, () => undefined);
  }

  /** The reply line, if the message gets one. `ping` never touches the device; `initialize` asks it briefly for its own instructions. */
  async handle(msg: Message): Promise<string | undefined> {
    // JSON-RPC batches went away in MCP 2025-06-18.
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return failure(null, -32600, 'Invalid Request');
    // Responses to requests we never send, and anything else without a method.
    if (typeof msg.method !== 'string') return undefined;
    const notification = !('id' in msg);
    const id = (msg.id ?? null) as Id;
    const params = (msg.params && typeof msg.params === 'object' ? msg.params : {}) as Record<string, unknown>;
    if (notification) return undefined;
    try {
      switch (msg.method) {
        case 'initialize': {
          const requested = params.protocolVersion;
          const protocolVersion = typeof requested === 'string' && PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0];
          const device = await this.current()
            .then(p => p.client.rpc<{ instructions?: string }>('initialize', {
              protocolVersion, capabilities: {}, clientInfo: { name: 'decky-toolkit', version: VERSION },
            }, INSTRUCTIONS_TIMEOUT_MS))
            .catch(() => undefined);
          return result(id, {
            protocolVersion,
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name: 'decky-toolkit', version: VERSION },
            instructions: 'Tools that inspect and control the paired Steam Deck running Decky Loader (screen, logs, plugins, Steam UI, input) '
              + `plus plugin_deploy to install a Decky plugin from this machine; if a tool says the device is not paired, ${PAIR_HINT} in a terminal.`
              + (device?.instructions ? ` ${device.instructions}` : ''),
          });
        }
        case 'ping':
          return result(id, {});
        case 'tools/list':
          return result(id, { tools: await this.listTools() });
        case 'tools/call':
          return await this.callTool(id, params);
        default:
          return failure(id, -32601, `Method not found: ${msg.method}`);
      }
    } catch (e) {
      return failure(id, e instanceof InvalidParams ? -32602 : -32603, e instanceof Error ? e.message : String(e));
    }
  }

  /** Newline-delimited JSON-RPC; requests are answered as they complete, so a slow tool call does not hold up a ping. */
  serve(input: Readable, output: Writable): Promise<void> {
    const send = async (line: string) => {
      if (!output.write(line + '\n')) await once(output, 'drain');
    };
    this.notify = line => void send(line);
    const watcher = identityFile.watch(f => {
      this.paired = Promise.resolve(f && pairedWith(f));
      void this.checkTools(true);
      this.follow();
    });
    this.follow();
    const timer = setInterval(() => void this.checkTools(), TOOLS_CHECK_MS);
    timer.unref();
    const pending = new Set<Promise<void>>();
    const rl = readline.createInterface({ input, crlfDelay: Infinity });
    rl.on('line', line => {
      if (!line.trim()) return;
      let msg: Message;
      try {
        msg = JSON.parse(line);
      } catch {
        void send(failure(null, -32700, 'Parse error'));
        return;
      }
      const job = this.handle(msg)
        .then(reply => (reply === undefined ? undefined : send(reply)))
        .catch(e => this.log(`decky-toolkit: ${e instanceof Error ? e.stack : e}`));
      pending.add(job);
      void job.finally(() => pending.delete(job));
    });
    return new Promise(resolve => rl.on('close', () => void Promise.all(pending).then(() => {
      clearInterval(timer);
      watcher.close();
      this.followGen++;
      this.events?.close();
      resolve();
    })));
  }
}
