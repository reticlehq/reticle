// Render every artifact SVG to PNG @2x via headless Chromium (Playwright).
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { chromium } from 'playwright';

const DIR = 'bench/artifacts';
const svgs = readdirSync(DIR).filter((f) => f.endsWith('.svg'));
const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 2 });
for (const f of svgs) {
  const svg = readFileSync(`${DIR}/${f}`, 'utf8');
  const m = svg.match(/width="(\d+)"\s+height="(\d+)"/);
  const w = m ? +m[1] : 800,
    h = m ? +m[2] : 600;
  await page.setViewportSize({ width: w, height: h });
  await page.setContent(`<body style="margin:0">${svg}</body>`, { waitUntil: 'networkidle' });
  await page.screenshot({
    path: `${DIR}/${f.replace('.svg', '.png')}`,
    clip: { x: 0, y: 0, width: w, height: h },
  });
  console.log(`png: ${f.replace('.svg', '.png')} (${w}x${h})`);
}
await browser.close();
process.exit(0);
