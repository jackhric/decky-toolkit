import searchWebm from '../../assets/clips/search.webm?url';
import searchMp4 from '../../assets/clips/search.mp4?url';
import searchPoster from '../../assets/clips/search.webp?url';
import installWebm from '../../assets/clips/install.webm?url';
import installMp4 from '../../assets/clips/install.mp4?url';
import installPoster from '../../assets/clips/install.webp?url';
import devicesWebm from '../../assets/clips/devices.webm?url';
import devicesMp4 from '../../assets/clips/devices.mp4?url';
import devicesPoster from '../../assets/clips/devices.webp?url';

export type Glyph = 'deploy' | 'screen' | 'logs' | 'console' | 'pad' | 'api' | 'reload' | 'audio' | 'panel';

export type Tile =
  | { kind: 'feature'; title: string; sub: string; glyph: Glyph; tone: number }
  | { kind: 'log'; lines: string[] }
  | { kind: 'code'; lines: string[] }
  | { kind: 'clip'; webm: string; mp4: string; poster: string };

const features: Tile[] = [
  { kind: 'feature', title: 'Deploy on save', sub: 'or Ctrl+Alt+D', glyph: 'deploy', tone: 3 },
  { kind: 'feature', title: 'Live screen', sub: '60 fps, with sound', glyph: 'screen', tone: 1 },
  { kind: 'feature', title: 'Plugin logs', sub: 'Streamed to your editor', glyph: 'logs', tone: 2 },
  { kind: 'feature', title: 'Steam console', sub: 'SharedJSContext', glyph: 'console', tone: 0 },
  { kind: 'feature', title: 'Your gamepad', sub: 'Plus virtual pads', glyph: 'pad', tone: 3 },
  { kind: 'feature', title: 'HTTP + MCP', sub: 'Script everything', glyph: 'api', tone: 1 },
  { kind: 'feature', title: 'Hot reload', sub: 'No loader restart', glyph: 'reload', tone: 2 },
  { kind: 'feature', title: 'Deck audio', sub: 'Streams with the screen', glyph: 'audio', tone: 0 },
  { kind: 'feature', title: 'Quick Access', sub: 'Jump to your panel', glyph: 'panel', tone: 2 },
];

const extras: Tile[] = [
  { kind: 'log', lines: ['[decky] loading plugin', '[decky] Decky Toolkit 0.2.1', '[toolkit] MCP on :8765', '[toolkit] paired 10.0.1.50'] },
  { kind: 'code', lines: ['@callable', 'async def greet(self):', '    return "hi Deck"'] },
  { kind: 'clip', webm: installWebm, mp4: installMp4, poster: installPoster },
  { kind: 'log', lines: ['pnpm run build', 'deploy Example Plugin', 'reloaded Example Plugin', 'no loader restart'] },
  { kind: 'clip', webm: searchWebm, mp4: searchMp4, poster: searchPoster },
  { kind: 'code', lines: ["call('get_settings')", '  .then(setState)', '// live on the Deck'] },
  { kind: 'clip', webm: devicesWebm, mp4: devicesMp4, poster: devicesPoster },
];

export function tileSet(seed = 0): Tile[] {
  const out: Tile[] = [];
  let f = seed % features.length;
  let e = seed % extras.length;
  for (let i = 0; i < 16; i++) {
    if (i % 3 === 2) out.push(extras[e++ % extras.length]);
    else out.push(features[f++ % features.length]);
  }
  return out;
}
