// Cut vertical 9:16 (1080x1920) reels of all demos: video as a rounded band on brand bg.
// Run: node assets/marketing/demo/verticalize.mjs
import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const DEMOS = join(here, '..', 'demos');
const W = 1080, H = 1920;
const probe = (f) => Number(execSync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${f}"`).toString().trim());

const jobs = [
  { src: 'demo-explainer.mp4', out: 'demo-explainer-vertical.mp4' },
  { src: 'demo-explainer-2.mp4', out: 'demo-explainer-2-vertical.mp4' },
  { src: 'demo-caught-it.mp4', out: 'demo-caught-it-vertical.mp4' },
  { src: 'demo-agent-tour.mp4', out: 'demo-agent-tour-vertical.mp4' },
  { src: 'demo-talks-to-site.mp4', out: 'demo-talks-to-site-vertical.mp4' },
  { src: 'demo-prompt-verified.mp4', out: 'demo-prompt-verified-vertical.mp4' },
  { src: 'demo-montage.mp4', out: 'demo-montage-vertical.mp4' },
];

const browser = await chromium.launch();
for (const j of jobs) {
  const srcPath = join(DEMOS, j.src);
  const dur = probe(srcPath);
  const recDir = mkdtempSync(join(tmpdir(), 'vert-'));
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, recordVideo: { dir: recDir, size: { width: W, height: H } } });
  const page = await ctx.newPage();
  await page.goto('file://' + join(here, 'vframe.html') + '?src=' + encodeURIComponent('../demos/' + j.src));
  try { await page.evaluate(() => document.fonts.ready); } catch {}
  // wait for the band video to be ready, then restart cleanly and play
  await page.waitForTimeout(800);
  await page.evaluate(() => { const v = document.getElementById('v'); v.currentTime = 0; v.play().catch(() => {}); });
  await page.waitForTimeout(dur * 1000 + 600);
  const v = await page.video().path();
  await page.close(); await ctx.close();
  const out = join(DEMOS, j.out);
  execSync(`ffmpeg -y -i "${v}" -r 30 -s ${W}x${H} -pix_fmt yuv420p -c:v libx264 -crf 21 -an -movflags +faststart "${out}"`, { stdio: 'ignore' });
  rmSync(recDir, { recursive: true, force: true });
  process.stdout.write(`✓ ${j.out}  (${dur.toFixed(0)}s)\n`);
}
await browser.close();
process.stdout.write('\ndone\n');
