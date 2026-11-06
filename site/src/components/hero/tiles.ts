export type Glyph =
  | 'deploy' | 'reload' | 'screen' | 'input' | 'pad' | 'navigate' | 'panel' | 'logs' | 'console' | 'play' | 'folder' | 'api'
  | 'lock' | 'discover';

export type Tile =
  | { kind: 'feature'; title: string; sub: string; glyph: Glyph; tone: number }
  | { kind: 'log'; lines: string[] }
  | { kind: 'code'; lines: string[] }
  | { kind: 'clip'; webm: string; mp4: string; poster: string };

// Every clip in assets/clips joins the hero: <name>.webm + <name>.mp4 + <name>.webp (poster).
const files = import.meta.glob<string>('../../assets/clips/*.{webm,mp4,webp}', { query: '?url', import: 'default', eager: true });
const byName = new Map<string, Record<string, string>>();
for (const [path, url] of Object.entries(files)) {
  const m = /([^/]+)\.(webm|mp4|webp)$/.exec(path)!;
  byName.set(m[1], { ...byName.get(m[1]), [m[2]]: url });
}
const named = [...byName].filter(([, f]) => f.webm && f.mp4 && f.webp).sort(([a], [b]) => a.localeCompare(b));
// Full-workspace clips (ws-*) alternate with close-ups so neighbouring tiles differ.
const wide = named.filter(([n]) => n.startsWith('ws-'));
const close = named.filter(([n]) => !n.startsWith('ws-'));
const order: typeof named = [];
for (let i = 0; i < Math.max(wide.length, close.length * 0.5); i++) {
  if (wide.length) order.push(wide[i % wide.length]);
  if (close.length) order.push(close[(2 * i) % close.length], close[(2 * i + 1) % close.length]);
}
const clips: Tile[] = order.map(([, f]) => ({ kind: 'clip', webm: f.webm, mp4: f.mp4, poster: f.webp }));

// One card per feature.
const features: Tile[] = [
  { kind: 'feature', title: 'One-click deploy', sub: 'Reloads just your plugin', glyph: 'deploy', tone: 3 },
  { kind: 'feature', title: 'Live reload', sub: 'Your device follows every save', glyph: 'reload', tone: 1 },
  { kind: 'feature', title: 'Live screen', sub: '60 fps, inside your editor', glyph: 'screen', tone: 2 },
  { kind: 'feature', title: 'Remote input', sub: 'Keyboard, mouse and gamepad', glyph: 'input', tone: 0 },
  { kind: 'feature', title: 'Virtual controllers', sub: 'Managed through Steam Input', glyph: 'pad', tone: 3 },
  { kind: 'feature', title: 'Jump anywhere', sub: 'Any Steam page in one step', glyph: 'navigate', tone: 1 },
  { kind: 'feature', title: 'Quick Access', sub: "Open your plugin's panel", glyph: 'panel', tone: 2 },
  { kind: 'feature', title: 'Live logs', sub: 'Loader and plugin, streamed', glyph: 'logs', tone: 0 },
  { kind: 'feature', title: 'Steam console', sub: 'JS in SharedJSContext', glyph: 'console', tone: 3 },
  { kind: 'feature', title: 'Games', sub: 'Launch and stop from VS Code', glyph: 'play', tone: 1 },
  { kind: 'feature', title: 'Saves and prefixes', sub: 'Browse them over decky://', glyph: 'folder', tone: 2 },
  { kind: 'feature', title: 'HTTP + MCP', sub: 'For your tools and agents', glyph: 'api', tone: 0 },
  { kind: 'feature', title: 'Secure pairing', sub: 'Approved on the device', glyph: 'lock', tone: 3 },
  { kind: 'feature', title: 'Device discovery', sub: 'Finds SteamOS devices on your network', glyph: 'discover', tone: 1 },
];

const extras: Tile[] = [
  { kind: 'log', lines: ['[decky] loading plugin', '[decky] Decky Toolkit 0.2.1', '[toolkit] MCP on :8765', '[toolkit] paired 10.0.1.50'] },
  { kind: 'code', lines: ['@callable', 'async def greet(self):', '    return "hi SteamOS"'] },
  { kind: 'log', lines: ['pnpm run build', 'deploy Example Plugin', 'reloaded Example Plugin', 'no loader restart'] },
  { kind: 'code', lines: ["call('get_settings')", '  .then(setState)', '// live on the device'] },
];

/** Two of every three tiles are clips; features cycle through the rest so every one shows, with a few log/code cards. */
export function heroTiles(count: number, cols = 6): Tile[] {
  const out: Tile[] = [];
  let c = 0, f = 0, e = 0, other = 0;
  for (let i = 0; i < count; i++) {
    // Shifting by row runs the non-clip cards diagonally instead of in fixed columns.
    if ((i + Math.floor(i / cols)) % 3 !== 0 && clips.length) out.push(clips[c++ % clips.length]);
    else if (other++ % 6 === 3) out.push(extras[e++ % extras.length]);
    else out.push(features[f++ % features.length]);
  }
  return out;
}
