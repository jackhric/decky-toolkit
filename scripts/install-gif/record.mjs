import { createRequire } from 'node:module';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const cache = process.env.GIF_CACHE;
const require = createRequire(path.join(cache, 'pw', 'package.json'));
const { _electron } = require('playwright-core');

const out = path.join(cache, 'rec');
const profile = path.join(cache, 'profile');
const extDir = path.join(cache, 'extensions');
const work = path.join(cache, 'decky_plugin_example');
const [W, H] = [1000, 660];

for (const d of [out, profile, extDir, work]) rmSync(d, { recursive: true, force: true });
for (const d of [out, path.join(profile, 'User'), extDir]) mkdirSync(d, { recursive: true });
cpSync(path.join(cache, 'template'), work, { recursive: true, filter: src => !src.includes(`${path.sep}.git`) || src.endsWith('.gitignore') });
writeFileSync(path.join(profile, 'User', 'settings.json'), JSON.stringify({
  'workbench.startupEditor': 'none',
  'workbench.secondarySideBar.defaultVisibility': 'hidden',
  'chat.disableAIFeatures': true,
  'workbench.tips.enabled': false,
  'workbench.welcomePage.walkthroughs.openOnInstall': false,
  'telemetry.telemetryLevel': 'off',
  'update.mode': 'none',
  'extensions.ignoreRecommendations': true,
  'extensions.autoCheckUpdates': false,
  'extensions.autoUpdate': false,
  'workbench.enableExperiments': false,
  'workbench.colorTheme': 'Default Dark Modern',
  'window.zoomLevel': 1,
  'window.commandCenter': false,
  'workbench.layoutControl.enabled': false,
  'editor.minimap.enabled': false,
  'security.workspace.trust.enabled': false,
  'window.restoreWindows': 'none',
}, null, 2));

const app = await _electron.launch({
  executablePath: path.join(cache, 'VSCode-linux-x64', 'code'),
  args: ['--no-sandbox', '--disable-gpu', '--user-data-dir', profile, '--extensions-dir', extDir,
    '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--new-window', work],
  recordVideo: { dir: path.join(out, 'video'), size: { width: W, height: H } },
  timeout: 60000,
});
const win = await app.firstWindow();
const t0 = Date.now();
const marks = {};
const mark = k => { marks[k] = (Date.now() - t0) / 1000; };

await app.evaluate(({ BrowserWindow }, [w, h]) => { const b = BrowserWindow.getAllWindows()[0]; b.setContentSize(w, h); b.center(); }, [W, H]);
await win.waitForSelector('.monaco-workbench', { timeout: 60000 });
await win.waitForTimeout(2000);

// Playwright's mouse is invisible in recordings, so a macOS-style pointer is drawn in the page.
await win.evaluate(() => {
  const ns = 'http://www.w3.org/2000/svg';
  const c = document.createElement('div');
  c.style.cssText = 'position:fixed;left:0;top:0;width:17px;height:17px;z-index:2147483647;pointer-events:none;transform:translate(-100px,-100px)';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '17'); svg.setAttribute('height', '17');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', 'M5 2.5v17.2l4.3-4.1 2.9 6.6 2.9-1.3-2.9-6.5h6z');
  p.setAttribute('fill', '#000'); p.setAttribute('stroke', '#fff'); p.setAttribute('stroke-width', '1.5'); p.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(p); c.appendChild(svg); document.body.appendChild(c);
  document.addEventListener('mousemove', e => { c.style.transform = `translate(${e.clientX - 3.5}px,${e.clientY - 1.8}px)`; }, true);
});

let mx = W / 2, my = H / 2;
const ease = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const glide = async (x, y, ms = 1000) => {
  const [sx, sy] = [mx, my];
  const n = Math.max(15, Math.round(ms / 16));
  for (let i = 1; i <= n; i++) {
    const e = ease(i / n);
    await win.mouse.move(sx + (x - sx) * e, sy + (y - sy) * e);
    await win.waitForTimeout(ms / n);
  }
  [mx, my] = [x, y];
};
const center = async loc => { const b = await loc.boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2]; };
const clickOn = async (loc, ms) => {
  const [x, y] = await center(loc);
  await glide(x, y, ms);
  await win.waitForTimeout(350);
  await win.mouse.down(); await win.waitForTimeout(90); await win.mouse.up();
  await win.waitForTimeout(200);
};
let seed = 7;
const jitter = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const typeLikeAPerson = async text => {
  for (const ch of text) { await win.keyboard.type(ch); await win.waitForTimeout(ch === ' ' ? 260 : 150 + jitter() * 110); }
};

const side = await win.locator('.part.sidebar').boundingBox();
const sashes = await win.locator('.monaco-sash.vertical').evaluateAll(els => els.map(e => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, h: r.height }; }));
const edge = side.x + side.width;
const sash = sashes.filter(r => r.h > 100).sort((a, b) => Math.abs(a.x - edge) - Math.abs(b.x - edge))[0];
await win.mouse.move(sash.x, sash.y);
await win.mouse.down();
await win.mouse.move(sash.x + 60, sash.y, { steps: 6 });
await win.mouse.move(sash.x + 115, sash.y, { steps: 6 });
await win.mouse.up();
[mx, my] = [W * 0.55, H * 0.45];
await win.mouse.move(mx, my);
await win.waitForTimeout(600);

mark('start');
await win.waitForTimeout(1200);

await clickOn(win.locator('.activitybar .action-label[aria-label^="Extensions"]').first(), 1050);
await win.waitForTimeout(700);
await clickOn(win.locator('.extensions-viewlet .suggest-input-container').first(), 900);
await win.waitForTimeout(900);
await typeLikeAPerson('decky toolkit');

const row = win.locator('.extensions-viewlet .monaco-list-row', { hasText: 'Decky Toolkit' }).first();
await row.waitFor({ timeout: 30000 });
await win.waitForTimeout(1600);
await clickOn(row.locator('.extension-action.install').first(), 1000);

const trust = win.getByRole('button', { name: 'Trust Publisher & Install' });
await trust.waitFor({ timeout: 30000 });
await win.waitForTimeout(1800);
await clickOn(trust, 1000);

await row.locator('.extension-action.manage:not(.hide)').waitFor({ timeout: 90000 });
await win.waitForTimeout(1300);
await clickOn(win.locator('.activitybar .action-label[aria-label^="Decky"]').first(), 1050);
const add = win.locator('.part.sidebar .monaco-button', { hasText: 'Add device' }).first();
await add.waitFor({ timeout: 30000 });
await win.waitForTimeout(700);
const [ax, ay] = await center(add);
await glide(ax, ay, 1000);
await win.waitForTimeout(3000);
mark('end');

const video = await win.video().path();
await app.close();
writeFileSync(path.join(out, 'marks.json'), JSON.stringify({ ...marks, video }));
console.log(`recorded ${(marks.end - marks.start).toFixed(1)} s`);
