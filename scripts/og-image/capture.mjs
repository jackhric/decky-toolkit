import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(path.join(process.env.OG_CACHE, 'pw', 'package.json'));
const { chromium } = require('playwright-core');

const browser = await chromium.launch(process.env.OG_CHROME ? { executablePath: process.env.OG_CHROME } : {});
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1, colorScheme: 'dark' });
await page.goto(process.env.OG_URL, { waitUntil: 'networkidle' });
await page.addStyleTag({ content: '.top { visibility: hidden !important; }' });
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(2500);
await page.screenshot({ path: process.env.OG_OUT, type: 'jpeg', quality: 88, clip: { x: 0, y: 0, width: 1200, height: 630 } });
await browser.close();
console.log(`wrote ${process.env.OG_OUT}`);
