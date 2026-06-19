// Render every card in v05-cards.html to a 2x PNG in this folder.
// Run: node assets/marketing/v0.5.0/render-cards.mjs
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const url = 'file://' + join(here, 'v05-cards.html');

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 2 });
await page.goto(url, { waitUntil: 'networkidle' });
try { await page.evaluate(() => document.fonts.ready); } catch {}
await page.waitForTimeout(700);

const names = await page.evaluate(() => window.__cardNames);
for (const name of names) {
  await page.locator(`[data-name="${name}"]`).screenshot({ path: join(here, `${name}.png`) });
  process.stdout.write(`✓ ${name}\n`);
}
await browser.close();
process.stdout.write(`\nrendered ${names.length} cards\n`);
