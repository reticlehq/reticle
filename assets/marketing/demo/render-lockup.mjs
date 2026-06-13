// Render the Syrin/Iris README lockup to transparent PNGs (light + dark theme variants).
// Run: node assets/marketing/demo/render-lockup.mjs
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', '..', 'readme');
const browser = await chromium.launch();
for (const theme of ['dark', 'light']) {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 }, deviceScaleFactor: 3 });
  await page.goto('file://' + join(here, 'lockup.html') + '?theme=' + theme);
  try { await page.evaluate(() => document.fonts.ready); } catch {}
  await page.waitForTimeout(400);
  const el = await page.$('.lockup');
  const name = theme === 'dark' ? 'lockup-on-dark.png' : 'lockup-on-light.png';
  await el.screenshot({ path: join(out, name), omitBackground: true });
  await page.close();
  process.stdout.write(`✓ ${name}\n`);
}
await browser.close();
