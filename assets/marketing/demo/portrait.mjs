// Portrait 9:16 (1080x1920) demos: real clip composited onto the iris brand frame via ffmpeg.
// ffmpeg decodes the H.264 clips (the browser <video> path could not). Run after build.mjs.
// Run: node assets/marketing/demo/portrait.mjs [nameStem]
import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readdirSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const DEMOS = join(here, '..', 'demos');
// band rect inside vframe-bg.html (must match the .well geometry there)
const BX = 40, BY = 620, BW = 1000, BH = 563, R = 28;

const only = process.argv[2];
let files = readdirSync(DEMOS).filter((f) => f.endsWith('.mp4') && !f.includes('-vertical') && f.startsWith('demo-'));
if (only) files = files.filter((f) => f.includes(only));

// render the static brand frame (exactly 1080x1920) and a rounded-rect alpha mask
const browser = await chromium.launch();
const tmp = mkdtempSync(join(tmpdir(), 'portrait-'));
const bgPng = join(tmp, 'bg.png');
const maskPng = join(tmp, 'mask.png');

const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
await page.goto('file://' + join(here, 'vframe-bg.html'), { waitUntil: 'networkidle' });
try { await page.evaluate(() => document.fonts.ready); } catch {}
await page.waitForTimeout(500);
await page.screenshot({ path: bgPng });

// rounded-rect mask: white rounded rect on black, exactly band size
await page.setViewportSize({ width: BW, height: BH });
await page.setContent(`<div style="width:${BW}px;height:${BH}px;background:#000"><div style="width:${BW}px;height:${BH}px;border-radius:${R}px;background:#fff"></div></div>`);
await page.screenshot({ path: maskPng });
await page.close();
await browser.close();

const probe = (f) => Number(execSync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${f}"`).toString().trim());
for (const f of files) {
  const src = join(DEMOS, f);
  const out = join(DEMOS, f.replace(/\.mp4$/, '-vertical.mp4'));
  const dur = probe(src);
  const fc = [
    `[1:v]scale=${BW}:${BH},setsar=1[vid]`,
    `[2:v]format=gray,scale=${BW}:${BH}[m]`,
    `[vid][m]alphamerge[rv]`,
    `[0:v][rv]overlay=${BX}:${BY}:format=auto:shortest=1[o]`,
  ].join(';');
  execSync(
    `ffmpeg -y -loop 1 -framerate 30 -i "${bgPng}" -i "${src}" -loop 1 -i "${maskPng}" ` +
    `-filter_complex "${fc}" -map "[o]" -t ${dur.toFixed(2)} -r 30 -pix_fmt yuv420p ` +
    `-c:v libx264 -preset veryfast -crf 22 -an -movflags +faststart "${out}"`,
    { stdio: 'ignore' },
  );
  process.stdout.write(`✓ ${f.replace(/\.mp4$/, '-vertical.mp4')} (${dur.toFixed(0)}s)\n`);
}
rmSync(tmp, { recursive: true, force: true });
process.stdout.write('\ndone\n');
