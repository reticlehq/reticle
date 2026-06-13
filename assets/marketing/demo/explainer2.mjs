// Explainer #2: hook -> two old ways (manual hides bugs / Playwright slow+expensive) ->
// 73x benchmark tease -> the third way -> slant showcase (cycling headlines) -> CTA -> graphs -> outro.
// Run: node assets/marketing/demo/explainer2.mjs
import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const MK = join(here, '..');
const OUT = join(MK, 'demos', 'demo-explainer-2.mp4');
const W = 1920, H = 1080;
const t = mkdtempSync(join(tmpdir(), 'ex2-'));
const ff = (a) => execSync(`ffmpeg -y ${a}`, { stdio: 'ignore' });
const probe = (f) => Number(execSync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${f}"`).toString().trim());

const browser = await chromium.launch();
async function record(url, ms, out, sync) {
  const recDir = mkdtempSync(join(tmpdir(), 'rec-'));
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, recordVideo: { dir: recDir, size: { width: W, height: H } } });
  const page = await ctx.newPage();
  await page.goto(url);
  try { await page.evaluate(() => document.fonts.ready); } catch {}
  await page.waitForTimeout(300);
  await page.evaluate((s) => { if (s) { const v = document.querySelector('#v'); if (v) { v.currentTime = 0; v.play().catch(() => {}); } } document.querySelector('.dcard,.stage')?.classList.add('go'); }, !!sync);
  await page.waitForTimeout(ms);
  const v = await page.video().path();
  await page.close(); await ctx.close();
  ff(`-i "${v}" -r 30 -s ${W}x${H} -pix_fmt yuv420p -c:v libx264 -crf 20 -an "${out}"`);
  rmSync(recDir, { recursive: true, force: true });
}
const card = (params, ms, out) => record('file://' + join(here, 'card.html') + '?' + new URLSearchParams(params).toString(), ms, out, false);
function kb(png, dur, out) {
  const inc = (0.10 / (dur * 30)).toFixed(6);
  ff(`-loop 1 -framerate 30 -t ${dur} -i "${png}" -vf "scale=2560:1440:force_original_aspect_ratio=increase,crop=2560:1440,zoompan=z='min(zoom+${inc},1.10)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${W}x${H}:fps=30,format=yuv420p" -an -c:v libx264 -crf 20 "${out}"`);
}

const segs = [];
const seg = (n) => { const p = join(t, `s${n}.mp4`); segs.push(p); return p; };

await card({ mode: 'hook', eyebrow: 'the problem', l1: 'Your AI says done.', l2: 'Does it actually work?', accent: 'red' }, 4000, seg(0));
await record('file://' + join(here, 'twoways.html'), 15500, seg(1), false);
kb(join(MK, 'g-token-bar.png'), 5, seg(2));
await card({ mode: 'hook', eyebrow: 'the third way', l1: 'Raw action. Real observation.', l2: 'No screenshots.', sub: 'Tell your agent your whole site. Let it check it for real.', accent: 'cyan' }, 4000, seg(3));
await record('file://' + join(here, 'showcase2.html'), 14500, seg(4), true);
await card({ mode: 'outro', l1: 'Give your agent', l2: 'a verdict.', accent: 'cyan', cta: 'npm i -D @syrin/iris' }, 3500, seg(5));
kb(join(MK, 'g-coverage-donut.png'), 5, seg(6));
await card({ mode: 'outro', l1: 'Stop being', l2: 'your AI’s QA.', accent: 'cyan', cta: 'npm i -D @syrin/iris' }, 4000, seg(7));

await browser.close();

let cur = segs[0];
for (let i = 1; i < segs.length; i++) {
  const d = probe(cur);
  const nxt = i === segs.length - 1 ? OUT : join(t, `x${i}.mp4`);
  const extra = i === segs.length - 1 ? '-movflags +faststart' : '';
  ff(`-i "${cur}" -i "${segs[i]}" -filter_complex "xfade=transition=fade:duration=0.5:offset=${(d - 0.5).toFixed(2)},format=yuv420p" -r 30 -an ${extra} "${nxt}"`);
  cur = nxt;
  process.stdout.write(`  joined ${i}/${segs.length - 1}\n`);
}
rmSync(t, { recursive: true, force: true });
process.stdout.write(`\n✓ ${OUT}\n`);
