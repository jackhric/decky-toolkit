import * as readline from 'readline';
import type { Readable, Writable } from 'stream';
import type { RestartMode, ToolCallResult, ToolDescription } from '@decky-toolkit/client/api';
import { DeckyClient } from '@decky-toolkit/client/client';
import { PAIR_HINT, RESTART_MODES, deploy, deviceStatus, explain, pairedClient } from './device';
import { VERSION } from './version';

export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const LOCAL_TOOLS: ToolDescription[] = [
  {
    name: 'deploy_plugin',
    description: 'Package a Decky plugin folder (plugin.json, dist/, main.py, py_modules/, ...) from this machine, install it on the paired device '
      + 'and wait until the device lists it. Run the plugin\'s own build first; dist/ must exist. Without `restart`, a new plugin restarts '
      + 'Decky Loader and an installed one is reloaded on its own.',
    inputSchema: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: 'Plugin folder on this machine; relative paths start at the working directory. Default: the working directory.' },
        restart: { type: 'string', enum: RESTART_MODES, description: 'none: only swap the files (a plugin with the debug flag may still be reloaded by the loader\'s file watcher); plugin: reload this plugin; loader: restart Decky Loader.' },
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

type Message = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
type Reply = { jsonrpc: '2.0'; id: unknown; result?: unknown; error?: { code: number; message: string } };

const text = (t: string, isError = false): ToolCallResult => ({ content: [{ type: 'text', text: t }], isError });

export class McpServer {
  private deviceTools?: { key: string; tools: Promise<ToolDescription[]> };

  constructor(private readonly log: (s: string) => void) {}

  /** The device's list, fetched once per device per process; a failed fetch is retried on the next request. */
  private async toolsOf(client: DeckyClient): Promise<ToolDescription[]> {
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
    try {
      const { client, file } = await pairedClient();
      try {
        return [...(await this.toolsOf(client)).filter(t => !local.has(t.name)), ...LOCAL_TOOLS];
      } catch (e) {
        this.log(`decky-toolkit: device tools unavailable: ${explain(e, file.device)}\n`);
      }
    } catch (e) {
      this.log(`decky-toolkit: ${explain(e)}\n`);
    }
    return LOCAL_TOOLS;
  }

  private async callTool(params: Record<string, unknown>): Promise<ToolCallResult> {
    const name = params.name;
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (typeof name !== 'string') throw Object.assign(new Error('tools/call needs a tool name'), { code: -32602 });
    if (typeof args !== 'object' || Array.isArray(args)) throw Object.assign(new Error('tools/call arguments must be an object'), { code: -32602 });
    if (name === 'device_status') return text(JSON.stringify(await deviceStatus(), null, 2));
    if (name === 'deploy_plugin') {
      const dir = args.dir ?? '.';
      const restart = args.restart;
      if (typeof dir !== 'string') return text('dir must be a string', true);
      if (restart !== undefined && !RESTART_MODES.includes(restart as RestartMode)) return text(`restart must be one of ${RESTART_MODES.join(', ')}`, true);
      try {
        return text(JSON.stringify(await deploy(dir, restart as RestartMode | undefined, s => this.log(s)), null, 2));
      } catch (e) {
        return text(`deploy failed: ${explain(e)}`, true);
      }
    }
    let device;
    try {
      const { client, file } = await pairedClient();
      device = file.device;
      return await client.callTool(name, args, 300000);
    } catch (e) {
      return text(`${name}: ${explain(e, device)}`, true);
    }
  }

  async handle(msg: Message): Promise<Reply | undefined> {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
    // Responses to requests we never send, and anything else without a method.
    if (typeof msg.method !== 'string') return undefined;
    const notification = !('id' in msg);
    const id = msg.id ?? null;
    const params = (msg.params && typeof msg.params === 'object' ? msg.params : {}) as Record<string, unknown>;
    const ok = (result: unknown): Reply | undefined => (notification ? undefined : { jsonrpc: '2.0', id, result });
    try {
      switch (msg.method) {
        case 'initialize': {
          const requested = params.protocolVersion;
          return ok({
            protocolVersion: typeof requested === 'string' && PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'decky-toolkit', version: VERSION },
            instructions: 'Tools that inspect and control the paired Steam Deck running Decky Loader (screen, logs, plugins, Steam UI, input) '
              + `plus deploy_plugin to install a Decky plugin from this machine; if a tool says the device is not paired, ${PAIR_HINT} in a terminal.`,
          });
        }
        case 'ping':
          return ok({});
        case 'tools/list':
          return ok({ tools: await this.listTools() });
        case 'tools/call':
          return ok(await this.callTool(params));
        default:
          if (notification) return undefined;
          return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
      }
    } catch (e) {
      if (notification) return undefined;
      const code = typeof (e as { code?: unknown }).code === 'number' ? (e as { code: number }).code : -32603;
      return { jsonrpc: '2.0', id, error: { code, message: e instanceof Error ? e.message : String(e) } };
    }
  }

  /** Newline-delimited JSON-RPC; requests are answered as they complete, so a slow tool call does not hold up a ping. */
  serve(input: Readable, output: Writable): Promise<void> {
    const send = (reply: unknown) => { output.write(JSON.stringify(reply) + '\n'); };
    const pending = new Set<Promise<void>>();
    const rl = readline.createInterface({ input, crlfDelay: Infinity });
    rl.on('line', line => {
      if (!line.trim()) return;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        return;
      }
      const job = (async () => {
        if (Array.isArray(msg)) {
          if (!msg.length) return send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
          const replies = (await Promise.all(msg.map(m => this.handle(m as Message)))).filter(r => r);
          if (replies.length) send(replies);
        } else {
          const reply = await this.handle(msg as Message);
          if (reply) send(reply);
        }
      })().catch(e => this.log(`decky-toolkit: ${e instanceof Error ? e.stack : e}\n`));
      pending.add(job);
      void job.finally(() => pending.delete(job));
    });
    return new Promise(resolve => rl.on('close', () => void Promise.all(pending).then(() => resolve())));
  }
}
