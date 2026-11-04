import sitemap from '@astrojs/sitemap';
import starlight from '@astrojs/starlight';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'astro/config';

const repo = 'https://github.com/jackhric/decky-toolkit';
const ogImage = 'https://jackhric.github.io/decky-toolkit/og.jpg';

export default defineConfig({
  site: 'https://jackhric.github.io',
  base: '/decky-toolkit',
  integrations: [
    sitemap({ filter: page => !page.includes('/variants/') }),
    starlight({
      title: 'Decky Toolkit',
      description: 'Build, test and deploy SteamOS plugins quickly from VS Code or VSCodium.',
      components: { SiteTitle: './src/components/docs/SiteTitle.astro' },
      favicon: '/favicon.svg',
      social: [{ icon: 'github', label: 'GitHub', href: repo }],
      editLink: { baseUrl: `${repo}/edit/dev/site/` },
      lastUpdated: true,
      customCss: ['./src/styles/docs.css'],
      head: [
        { tag: 'meta', attrs: { property: 'og:image', content: ogImage } },
        { tag: 'meta', attrs: { property: 'og:image:width', content: '1200' } },
        { tag: 'meta', attrs: { property: 'og:image:height', content: '630' } },
        { tag: 'meta', attrs: { name: 'twitter:card', content: 'summary_large_image' } },
        { tag: 'meta', attrs: { name: 'twitter:image', content: ogImage } },
      ],
      sidebar: [
        { label: 'Start here', items: ['docs', 'docs/getting-started', 'docs/faq'] },
        { label: 'Features', items: [{ autogenerate: { directory: 'docs/features' } }] },
      ],
    }),
  ],
  vite: {
    plugins: [tailwindcss()],
    server: { fs: { allow: ['..'] } },
  },
});
