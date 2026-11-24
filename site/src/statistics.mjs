// Umami statistics and session recording at stats.omnosoftware.com. Every site under jackhric.github.io shares
// this one website, so pages show up there by path (/r3cui/, /decky-toolkit/, /boilerRomM/, ...).
// Used by Starlight's `head` config (docs pages) and by components/Statistics.astro (the landing page).
// Production builds only; `data-domains` also keeps any other host out of the numbers.
const origin = 'https://stats.omnosoftware.com';
const websiteId = '8cda325e-240c-4aa8-9b86-25c3cddbda05';

export const statisticsHead = [
  {
    tag: 'script',
    attrs: { defer: true, src: `${origin}/getinfo.js`, 'data-website-id': websiteId, 'data-domains': 'jackhric.github.io' },
  },
  {
    tag: 'script',
    attrs: {
      defer: true,
      src: `${origin}/recorder.js`,
      'data-website-id': websiteId,
      'data-sample-rate': '1',
      'data-mask-level': 'moderate',
      'data-max-duration': '300000',
    },
  },
];
