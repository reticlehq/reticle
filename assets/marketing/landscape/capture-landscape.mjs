// Render the same reel sources as LANDSCAPE 1920x1080 MP4s (for X / YouTube / LinkedIn).
// Reuses reels/src/*.html, injecting landscape sizing. Run: node assets/marketing/landscape/capture-landscape.mjs [nameStem]
import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, '..', 'reels', 'src');
const W = 1920, H = 1080;
const only = process.argv[2];
let files = readdirSync(srcDir).filter((f) => f.endsWith('.html')).sort();
if (only) files = files.filter((f) => f.includes(only));

// override the vertical .reel sizing + scale type down to fit a wide frame
const LAND = `
  html,body{width:${W}px!important;height:${H}px!important}
  .reel{width:${W}px!important;height:${H}px!important}
  .reel h2{font-size:84px!important}
  .reel .big{font-size:176px!important}
  .reel .scene{padding:80px!important;gap:28px!important}
`;

const browser = await chromium.launch();
for (const f of files) {
  const html = readFileSync(join(srcDir, f), 'utf8');
  const m = html.match(/<!--DUR:(\d+)-->/);
  const dur = m ? Number(m[1]) : 14000;
  const recDir = mkdtempSync(join(tmpdir(), 'land-'));
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, recordVideo: { dir: recDir, size: { width: W, height: H } } });
  const page = await ctx.newPage();
  await page.goto('file://' + join(srcDir, f));
  await page.addStyleTag({ content: LAND });
  try { await page.evaluate(() => document.fonts.ready); } catch {}
  await page.waitForTimeout(250);
  await page.evaluate(() => document.querySelector('.reel')?.classList.add('go'));
  await page.waitForTimeout(dur + 400);
  const vpath = await page.video().path();
  await page.close();
  await ctx.close();
  const out = join(here, f.replace(/\.html$/, '.mp4'));
  execSync(`ffmpeg -y -i "${vpath}" -movflags +faststart -pix_fmt yuv420p -c:v libx264 -crf 21 -r 30 -an "${out}"`, { stdio: 'ignore' });
  rmSync(recDir, { recursive: true, force: true });
  process.stdout.write(`✓ ${f} -> 1920x1080\n`);
}
await browser.close();
process.stdout.write('\ndone\n');
