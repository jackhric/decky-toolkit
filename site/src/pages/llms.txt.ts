import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';

const url = (site: URL, slug: string) => new URL(`${import.meta.env.BASE_URL.replace(/\/$/, '')}/${slug}/`, site).href;

export const GET: APIRoute = async ({ site }) => {
  const docs = (await getCollection('docs')).sort((a, b) => (a.data.sidebar?.order ?? 0) - (b.data.sidebar?.order ?? 0) || a.id.localeCompare(b.id));
  const link = (d: (typeof docs)[number]) => `- [${d.data.title}](${url(site!, d.id)}): ${d.data.description ?? ''}`;
  const body = [
    '# Decky Toolkit',
    '',
    '> Decky Toolkit is a free, open-source (MIT) toolkit for building, testing and deploying Decky Loader plugins',
    '> for the Steam Deck and other SteamOS devices (SteamOS, Bazzite) from VS Code or VSCodium. A Decky Loader',
    '> plugin on the device runs an HTTP and MCP server on port 8765; the VS Code extension (jackhric.decky-toolkit)',
    '> live reloads the plugin in your workspace without restarting Decky Loader, shows the device',
    "> screen with sound, forwards keyboard, mouse and gamepad input, streams logs, and evaluates JavaScript in Steam's",
    '> SharedJSContext. Coding agents such as Claude Code can drive the device over MCP.',
    '',
    '## Docs',
    '',
    ...docs.filter(d => !d.id.startsWith('docs/features/')).map(link),
    '',
    '## Features',
    '',
    ...docs.filter(d => d.id.startsWith('docs/features/')).map(link),
    '',
    '## Optional',
    '',
    '- [Full docs as Markdown](' + url(site!, 'llms-full.txt').replace(/\/$/, '') + ')',
    '- [Source and reference (GitHub)](https://github.com/jackhric/decky-toolkit)',
    '- [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=jackhric.decky-toolkit)',
    '- [Open VSX](https://open-vsx.org/extension/jackhric/decky-toolkit)',
    '',
  ];
  return new Response(body.join('\n'), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
};
