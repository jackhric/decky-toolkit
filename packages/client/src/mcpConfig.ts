// The CLI reads the per-machine identity file, so the entry needs no URL or headers and survives editor restarts.
export const MCP_ENTRY = { command: 'npx', args: ['-y', 'decky-toolkit', 'mcp'] };
export const MCP_SERVER_NAME = 'decky';
export const CLAUDE_MCP_ADD = `claude mcp add ${MCP_SERVER_NAME} -- ${[MCP_ENTRY.command, ...MCP_ENTRY.args].join(' ')}`;

export type McpConfig = { mcpServers?: Record<string, unknown>; [k: string]: unknown };

export function parseMcpConfig(text: string): McpConfig {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`existing .mcp.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** `existing` with our server set to `entry`; other servers are kept. */
export function mergeMcpConfig(existing: McpConfig | undefined, entry: Record<string, unknown> = MCP_ENTRY): McpConfig {
  const config = { ...(existing ?? {}) };
  config.mcpServers = { ...(config.mcpServers ?? {}), [MCP_SERVER_NAME]: entry };
  return config;
}

export function formatMcpConfig(config: McpConfig): string {
  return JSON.stringify(config, null, 2) + '\n';
}

/**
 * An entry from an earlier session that points at the editor's loopback proxy by URL, moved to the URL `rebase`
 * gives for it; undefined when there is no such entry or `rebase` leaves it alone.
 */
export async function rebaseMcpConfig(config: McpConfig, rebase: (url: string) => Promise<string | undefined>): Promise<McpConfig | undefined> {
  const entry = config.mcpServers?.[MCP_SERVER_NAME] as Record<string, unknown> | undefined;
  const url = typeof entry?.url === 'string' ? await rebase(entry.url) : undefined;
  return entry && url ? mergeMcpConfig(config, { ...entry, url }) : undefined;
}
