// Mirrors docs/api.md in the repo root. Routes marked planned there may 404 on older devices.

export interface Health {
  ok: boolean;
  name: string;
  version: string;
  api_version: number;
  tools: number;
}

export type PairClientKind = 'vscode' | 'browser' | 'mcp' | 'other';

export interface PairRequestCreated {
  id: string;
  code: string;
  poll_after_ms: number;
}

/** `token`, `url` and `api_version` are present only on the first poll that sees the approval. */
export interface PairPoll {
  status: 'pending' | 'approved' | 'denied';
  token?: string;
  url?: string;
  api_version?: number;
}

export interface PairGrant {
  token: string;
  url: string;
  api_version: number;
}

export interface StreamStats {
  available: boolean;
  running: boolean;
  subscribers: number;
  fps: number;
  kbps: number;
  frames_total: number;
  uptime_s: number;
  width: number | null;
  height: number | null;
  settings: { fps: number; quality: number; width: number };
  error: string | null;
}

export interface InputSettings {
  enabled: boolean;
  backend: 'ei' | 'uinput' | null;
  available: boolean;
  reason: string | null;
}

export type RestartMode = 'loader' | 'plugin' | 'none';

export interface InstallResult {
  installed: { dir: string; name: string; version: string };
  restarted: RestartMode;
}

export interface PluginInfo {
  dir: string;
  name?: string;
  author?: string;
  flags?: string[];
  api_version?: number;
  version?: string | null;
  has_backend?: boolean;
  path?: string;
  [key: string]: unknown;
}

export interface LogQuery {
  source?: 'loader' | 'plugin';
  plugin?: string;
  tail?: number;
}

export interface LogTail {
  lines: string[];
}

export interface ErrorBody {
  error: string;
}

export type ToolName =
  | 'decky_status'
  | 'list_plugins'
  | 'read_plugin_log'
  | 'loader_log'
  | 'restart_loader'
  | 'cef_targets'
  | 'cef_evaluate'
  | 'cef_screenshot'
  | 'toast'
  | 'screen_capture'
  | 'stream_status'
  | 'read_file'
  | 'write_file'
  | 'install_plugin'
  | 'reload_plugin';

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse<T = unknown> {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: T;
  error?: JsonRpcError;
}

export interface ToolDescription {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolsListResult {
  tools: ToolDescription[];
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: string; [key: string]: unknown };

export interface ToolCallResult {
  content: ContentBlock[];
  isError: boolean;
}
