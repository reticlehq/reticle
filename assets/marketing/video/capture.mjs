// Record gif-hero.html (16s motion graphic) to webm, then encode MP4 + GIF.
// Run: node assets/marketing/video/capture.mjs
import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { renameSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..'); // assets/marketing/
const W = 1280, H = 720, PLAY_MS = 16400;

const recDir = mkdtempSync(join(tmpdir(), 'iris-rec-'));
const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: W, height: H },
  recordVideo: { dir: recDir, size: { width: W, height: H } },
});
const page = await ctx.newPage();
await page.goto('file://' + join(here, 'gif-hero.html'));
try { await page.evaluate(() => document.fonts.ready); } catch {}
await page.waitForTimeout(250);
await page.evaluate(() => document.body.classList.add('go')); // start the timeline
await page.waitForTimeout(PLAY_MS);
const vpath = await page.video().path();
await page.close();
await ctx.close();
await browser.close();

const mp4 = join(out, 'gif-hero.mp4');
const gif = join(out, 'gif-hero.gif');
const pal = join(recDir, 'palette.png');

process.stdout.write('encoding mp4...\n');
execSync(`ffmpeg -y -i "${vpath}" -movflags +faststart -pix_fmt yuv420p -c:v libx264 -crf 20 -r 30 -an "${mp4}"`, { stdio: 'ignore' });

process.stdout.write('encoding gif...\n');
execSync(`ffmpeg -y -i "${vpath}" -vf "fps=13,scale=760:-1:flags=lanczos,palettegen=stats_mode=diff" "${pal}"`, { stdio: 'ignore' });
execSync(`ffmpeg -y -i "${vpath}" -i "${pal}" -lavfi "fps=13,scale=760:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3" "${gif}"`, { stdio: 'ignore' });

rmSync(recDir, { recursive: true, force: true });
process.stdout.write(`\n✓ ${mp4}\n✓ ${gif}\n`);
