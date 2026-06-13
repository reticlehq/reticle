// Full side-by-side explainer: hook -> problem -> cost -> 73x tease -> SLANT showcase -> CTA -> graphs -> outro.
// Run: node assets/marketing/demo/explainer.mjs
import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const MK = join(here, '..');           // assets/marketing
const OUT = join(MK, 'demos', 'demo-explainer.mp4');
const W = 1920, H = 1080;
const t = mkdtempSync(join(tmpdir(), 'expl-'));
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
  if (sync) await page.evaluate(() => { const v = document.querySelector('#v'); if (v) { v.currentTime = 0; v.play().catch(() => {}); } document.querySelector('.stage,.dcard')?.classList.add('go'); });
  else await page.evaluate(() => document.querySelector('.dcard,.stage')?.classList.add('go'));
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

await card({ mode: 'hook', eyebrow: 'the problem', l1: 'Your AI ships broken code.', l2: 'And calls it done.', accent: 'red' }, 4000, seg(0));
kb(join(MK, 'camp-incident-report.png'), 6, seg(1));
kb(join(MK, 'g-cost-curve.png'), 5, seg(2));
await card({ mode: 'hook', eyebrow: 'there is a cheaper way', l1: '73× fewer tokens.', l2: 'And we show the honest math.', accent: 'cyan' }, 3500, seg(3));
kb(join(MK, 'g-token-bar.png'), 5, seg(4));
await record('file://' + join(here, 'showcase.html'), 14500, seg(5), true);
await card({ mode: 'outro', l1: 'Give your agent', l2: 'a verdict.', accent: 'cyan', cta: 'npm i -D @syrin/iris' }, 3500, seg(6));
kb(join(MK, 'g-coverage-donut.png'), 5, seg(7));
await card({ mode: 'outro', l1: 'Stop being', l2: 'your AI’s QA.', accent: 'cyan', cta: 'npm i -D @syrin/iris' }, 4000, seg(8));

await browser.close();

// crossfade chain
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
