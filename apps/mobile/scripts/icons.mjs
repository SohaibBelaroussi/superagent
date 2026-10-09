// Renders the app's icons and splash image from the web app's mark (apps/web/public/favicon.svg) with
// Playwright. Run after changing the mark:
//   pnpm --filter @superagent/mobile icons   (PW_CHANNEL=msedge or chrome uses an installed browser)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const out = fileURLToPath(new URL('../assets/', import.meta.url));
const tile = readFileSync(fileURLToPath(new URL('../../web/public/favicon.svg', import.meta.url)), 'utf8');
// The mark is everything after the tile's background.
const mark = tile.replace(/^[\s\S]*?<rect[^>]*\/>/, '').replace(/<\/svg>\s*$/, '');
const BACKGROUND = '#151515';

/** The mark at `scale` of the canvas, centred, on `background` (none: transparent). */
const svg = (scale, background, body = mark) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${
    background ? `<rect width="32" height="32" fill="${background}"/>` : ''
  }<g transform="translate(16 16) scale(${scale}) translate(-16 -16)">${body}</g></svg>`;

/** One colour for Android's themed (monochrome) icon: the system tints it. */
const monochrome = mark.replace(/#[0-9a-f]{3,8}/gi, '#ffffff');

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL });
for (const [name, size, image, transparent] of [
  // iOS and the fallback launcher icon: full bleed, the mark inside the rounding.
  ['icon.png', 1024, svg(0.72, BACKGROUND), false],
  // Android adaptive icon layers: the mark inside the safe zone (the middle 66 %).
  ['adaptive-icon.png', 1024, svg(0.6, null), true],
  ['adaptive-icon-monochrome.png', 1024, svg(0.6, null, monochrome), true],
  // The splash screen's mark, on the theme's background (set in app.config.ts).
  ['splash-icon.png', 512, svg(1, null), true],
  // Android's notification icon: white on transparent, filling most of its square.
  ['notification-icon.png', 96, svg(0.9, null, monochrome), true],
]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(
    `<html><body style="margin:0;background:transparent">${image.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`,
  );
  await page.screenshot({ path: join(out, name), omitBackground: transparent });
  await page.close();
}
await browser.close();
console.log('Icons written to', out);
