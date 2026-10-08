// Renders the web app's PNG icons from public/favicon.svg with Playwright. Run after changing the mark:
//   pnpm --filter @superagent/web icons   (PW_CHANNEL=msedge or chrome uses an installed browser)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const out = fileURLToPath(new URL('../public/', import.meta.url));
/** The rounded tile, transparent corners: browsers' tabs and app lists. */
const tile = readFileSync(join(out, 'favicon.svg'), 'utf8');
// The mark is everything after the tile's background.
const mark = tile.replace(/^[\s\S]*?<rect[^>]*\/>/, '').replace(/<\/svg>\s*$/, '');
/** Full bleed, the mark inside the maskable safe zone (the middle 80 %): Android masks it, iOS rounds it. */
const bleed = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#151515"/><g transform="translate(16 16) scale(0.72) translate(-16 -16)">${mark}</g></svg>`;

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL });
for (const [name, size, svg, transparent] of [
  ['icon-192.png', 192, tile, true],
  ['icon-512.png', 512, tile, true],
  ['icon-maskable-512.png', 512, bleed, false],
  ['apple-touch-icon.png', 180, bleed, false],
]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(
    `<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`,
  );
  await page.screenshot({ path: join(out, name), omitBackground: transparent });
  await page.close();
}
await browser.close();
console.log('Icons written to', out);
