// Mirrors docs/api.md in the repo root: `/health` and the client API under `/api/v1` (see `API_BASE` in client.ts).

export interface Health {
  ok: boolean;
  name: string;
  version: string;
  /** Client API versions the device serves, e.g. `["v1"]`; absent on devices from before the versioned API. */
  api?: string[];
  tools: number;
  /** Changes with any tool, description or schema; also sent as the `tools` event. */
  tools_hash: string;
  /** Identification for network discovery; absent on older builds. */
  hostname?: string;
  device_id?: string | null;
  os?: string | null;
}

export type PairClientKind = 'vscode' | 'browser' | 'mcp' | 'other';

export interface PairRequestCreated {
  id: string;
  code: string;
  poll_after_ms: number;
}

/** `client_cert` and `server_cert` (PEM) are present only on the first poll that sees the approval. */
export interface PairPoll {
  status: 'pending' | 'approved' | 'denied';
  client_cert?: string;
  server_cert?: string;
}

export interface PairGrant {
  client_cert: string;
  server_cert: string;
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
  settings: { fps: number; quality: number; width: number; audio?: boolean };
  /** Absent on devices without audio streaming. */
  audio?: AudioStats | null;
  error: string | null;
}

export interface AudioStats {
  enabled: boolean;
  available: boolean;
  running: boolean;
  subscribers: number;
  kbps: number;
  chunks_total: number;
  rms_db: number | null;
  error: string | null;
}

export interface StreamSettings {
  fps: number;
  quality: number;
  width: number;
  /** Absent on devices without audio streaming. */
  audio?: boolean;
  limits: { fps: [number, number]; quality: [number, number]; widths: number[]; audio?: [boolean, boolean] };
}

export interface StreamSettingsPatch {
  fps?: number;
  quality?: number;
  width?: number;
  audio?: boolean;
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

export type LiveReloadMode = 'frontend' | 'backend';

/** `POST /plugins/reload` with the plugin.json name and mode. Reloading our own backend only schedules it (`scheduled`). */
export interface LiveReloadResult {
  dir: string;
  name: string;
  mode: LiveReloadMode;
  load_ms?: number;
  reloaded?: boolean;
  /** Errors the plugin logged while loading, with bundle positions. */
  errors?: string[];
  restored?: string[];
  routes?: string[];
  scheduled?: boolean;
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

export interface SteamInputSlot {
  type: string;
  slot: number | null;
  name: string;
}

export interface ControllerInfo {
  id: string;
  name: string;
  kind: 'physical' | 'virtual';
  virtual_id: string | null;
  vendor: string;
  product: string;
  device: string;
  /** Null while Steam Input has not picked the device up. */
  steam: SteamInputSlot | null;
}

export interface VirtualPad {
  id: string;
  name: string;
  type: 'x360';
  created_at: number | string;
  last_event_at: number | string | null;
  /** The pad the server creates on its own for gamepad messages without `pad`. */
  auto: boolean;
}

export interface ControllersList {
  controllers: ControllerInfo[];
  virtual: VirtualPad[];
  input_enabled: boolean;
}

export interface VirtualPadCreated {
  id: string;
  name: string;
  type: string;
}

export interface UiRoute {
  path: string;
  title: string;
  /** Set when `path` holds `{placeholders}` such as `/library/app/{appid}`. */
  template?: boolean | string;
}

export interface UiRoutes {
  current: string;
  official: UiRoute[];
  plugins: { plugin: string; path: string; title: string }[];
  quick_access_tabs: string[];
}

export type NavigateRequest =
  | { path: string }
  | { action: 'back' | 'main_menu' | 'close_menus' }
  | { action: 'quick_access'; tab?: string }
  | { action: 'plugin'; plugin: string }
  | { action: 'app'; appid: number };

export interface NavigateResult {
  ok: boolean;
  current: string;
}

export interface AppSummary {
  appid: number;
  name: string | null;
  type: string;
  installed: boolean;
  running: boolean;
  install_dir: string | null;
  /** e.g. `proton_11`, `steamlinuxruntime_sniper` (native titles), null for most shortcuts. */
  compat_tool: string | null;
  compat_tool_display: string | null;
  size_on_disk: number | null;
  library: string | null;
  /** ISO time, null when never played. */
  last_played: string | null;
  installed_elsewhere?: string[];
  shortcut_exe?: string | null;
}

export interface AppsList {
  count: number;
  apps: AppSummary[];
}

/** `POST /apps/{appid}/launch` and `/terminate`. */
export interface AppActionResult {
  appid: number;
  name?: string;
  launched?: boolean;
  running?: boolean;
  terminated?: boolean;
  /** Why it did not start or stop, e.g. a Steam dialog. */
  note?: string;
}

/** `GET /apps/{appid}/proton-log`: `~/steam-<appid>.log` and the lines of Steam's logs that mention the app. */
export interface ProtonLog {
  appid: number;
  proton_log: { path: string; exists?: boolean; lines?: string[]; mtime?: string; hint?: string };
  steam_logs: { file: string; mtime: string; lines: string[] }[];
}

export interface DirEntry {
  path: string | null;
  exists: boolean;
  mtime?: string;
}

export interface GameDirs {
  appid: number;
  name: string | null;
  platform: 'proton' | 'native';
  compat_tool: string | null;
  steam_root: string;
  install_dir: DirEntry;
  compatdata: DirEntry;
  prefix: DirEntry;
  prefix_user_dirs: Record<'appdata_roaming' | 'appdata_local' | 'appdata_locallow' | 'documents' | 'saved_games', DirEntry & { matches?: string[] }>;
  account_id: string | null;
  userdata: DirEntry;
  cloud_remote: DirEntry;
  shader_cache: DirEntry;
  xdg: (DirEntry & { base?: string })[];
}

export interface SaveCandidate {
  path: string;
  size: number;
  mtime: string | null;
  found_by: string;
  rank: number;
  score: number;
}

export interface GameSaves {
  appid: number;
  name: string | null;
  steam_cloud: { name: string; root: number | string; size: number | null; time: number | null; local_path: string | null }[];
  candidates: SaveCandidate[];
  notes: string[];
}

export interface FsEntry {
  /** Relative to the listed directory. */
  path: string;
  type: 'file' | 'dir' | 'symlink' | 'other';
  size: number;
  mtime: string | null;
  target?: string;
  sensitive?: boolean;
}

export interface FsListing {
  path: string;
  depth: number;
  glob: string | null;
  entries: FsEntry[];
  count: number;
  truncated: boolean;
}

export interface PluginVersion {
  dir: string;
  name: string | null;
  version: string | null;
}

/** Payloads of the state events on `GET /events`, by event name. */
export interface DeviceState {
  /** `ToolRegistry.fingerprint()`: changes with any MCP tool, description or schema. */
  tools: { hash: string };
  stream_settings: StreamSettings;
  input_settings: InputSettings;
  plugins: { plugins: PluginVersion[] };
  controllers: Pick<ControllersList, 'controllers' | 'virtual'>;
  /** Counts only; pairing codes and request ids stay on the device. */
  pairing: { pending: number; paired: number };
}

/** The first event of every stream: the current value of each state event the device could read. */
export interface HelloEvent {
  version: string;
  api: string[];
  state: Partial<DeviceState>;
}

export type DeviceEventMap = DeviceState & {
  hello: HelloEvent;
  /** The server is stopping (plugin reload, loader restart); the stream ends right after. */
  shutdown: Record<string, never>;
};

export type DeviceEventName = keyof DeviceEventMap;
export type DeviceEvent = { [K in DeviceEventName]: { event: K; data: DeviceEventMap[K] } }[DeviceEventName];

export interface ErrorBody {
  error: string;
  /** `/fs/*` routes: ENOENT, EACCES, EEXIST, EISDIR, ENOTDIR, EFBIG. */
  code?: string;
}

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
