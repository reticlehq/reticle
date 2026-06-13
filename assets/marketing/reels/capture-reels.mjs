// Render every reels/src/*.html (vertical 1080x1920) to an MP4 in reels/.
// Each HTML declares duration on line 1: <!--DUR:ms-->. Run: node assets/marketing/reels/capture-reels.mjs
import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, 'src');
const W = 1080, H = 1920;
const only = process.argv[2]; // optional: render one file by name stem
let files = readdirSync(srcDir).filter((f) => f.endsWith('.html')).sort();
if (only) files = files.filter((f) => f.includes(only));

const browser = await chromium.launch();
for (const f of files) {
  const html = readFileSync(join(srcDir, f), 'utf8');
  const m = html.match(/<!--DUR:(\d+)-->/);
  const dur = m ? Number(m[1]) : 14000;
  const recDir = mkdtempSync(join(tmpdir(), 'reel-'));
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, recordVideo: { dir: recDir, size: { width: W, height: H } } });
  const page = await ctx.newPage();
  await page.goto('file://' + join(srcDir, f));
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
  process.stdout.write(`✓ ${f} -> ${(dur / 1000).toFixed(0)}s\n`);
}
await browser.close();
process.stdout.write('\ndone\n');
