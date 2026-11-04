import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';

export const GET: APIRoute = async ({ site }) => {
  const docs = (await getCollection('docs')).sort((a, b) => (a.data.sidebar?.order ?? 0) - (b.data.sidebar?.order ?? 0) || a.id.localeCompare(b.id));
  const base = import.meta.env.BASE_URL.replace(/\/$/, '');
  const pages = docs.map(d => [
    `# ${d.data.title}`,
    '',
    `Source: ${new URL(`${base}/${d.id}/`, site).href}`,
    '',
    d.data.description ? `> ${d.data.description}\n` : '',
    (d.body ?? '').replace(/^import .*$/gm, '').trim(),
  ].join('\n'));
  return new Response(pages.join('\n\n---\n\n') + '\n', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
};
