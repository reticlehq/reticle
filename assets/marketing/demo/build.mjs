// Build product demos: animated HOOK card -> real footage (Ken Burns zoom) -> OUTRO card, crossfaded.
// Run: node assets/marketing/demo/build.mjs [name]   (omit name to build all)
import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { rmSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const CLIPS = join(here, '..', '..', 'clips');
const OUT = join(here, '..', 'demos');
const W = 1920, H = 1080;
const c = (s) => `${CLIPS}/${s}`;

const DEMOS = {
  'caught-it': {
    hook: { eyebrow: 'the problem', l1: 'Your AI shipped a 401.', l2: 'And called it done.', accent: 'red', sub: '' },
    bits: [{ src: c('iris_login_redeploy_action.mov'), start: 1, dur: 12, speed: 1.25, pre: 'crop=iw:iw*9/16' }],
    outro: { l1: 'Iris checks your AI’s work.', l2: 'In one call.', accent: 'cyan', cta: 'npm i -D @syrin/iris' },
  },
  'agent-tour': {
    hook: { eyebrow: 'the problem', l1: 'You stopped writing code.', l2: 'You’re still testing it.', accent: 'red' },
    bits: [{ src: c('iris_full_run.mov'), start: 3, dur: 30, speed: 1.6 }],
    outro: { l1: 'Your agent tests the whole app.', l2: 'Automatically.', accent: 'cyan', cta: 'npm i -D @syrin/iris' },
  },
  'talks-to-site': {
    hook: { eyebrow: 'the problem', l1: 'Screenshots are blind.', l2: 'Iris reads the wire.', accent: 'red' },
    bits: [{ src: c('iris_talking_to_website.mov'), start: 4, dur: 22, speed: 1.4 }],
    outro: { l1: 'Network. Console. Signals.', l2: 'The stuff pixels can’t show.', accent: 'cyan', cta: 'npm i -D @syrin/iris' },
  },
  'prompt-verified': {
    hook: { eyebrow: 'the problem', l1: 'AI generated it in seconds.', l2: 'But did it work?', accent: 'red' },
    bits: [{ src: c('iris_alianpost_post_generation.mov'), start: 2, dur: 20, speed: 1.4 }],
    outro: { l1: 'From prompt', l2: 'to proof.', accent: 'cyan', cta: 'npm i -D @syrin/iris' },
  },
  'montage': {
    hook: { eyebrow: 'open source', l1: 'This is what', l2: '“my AI tests itself” looks like.', accent: 'cyan' },
    bits: [
      { src: c('iris_login_redeploy_action.mov'), start: 6, dur: 4, speed: 1.3, pre: 'crop=iw:iw*9/16' },
      { src: c('iris_full_run.mov'), start: 30, dur: 5, speed: 1.6 },
      { src: c('iris_talking_to_website.mov'), start: 12, dur: 4, speed: 1.3 },
      { src: c('iris_alianpost_post_generation.mov'), start: 12, dur: 4, speed: 1.3 },
    ],
    outro: { l1: 'Iris', l2: 'Your agent checks its own work.', accent: 'cyan', cta: 'npm i -D @syrin/iris' },
  },
};

const probe = (f) => Number(execSync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${f}"`).toString().trim());
const ff = (args) => execSync(`ffmpeg -y ${args}`, { stdio: 'ignore' });
// Ken Burns zoom. fps=30 BEFORE zoompan so it sees the sped-up frame count (else duration doubles).
const ken = (speed, outdur) => {
  const inc = (0.16 / (outdur * 30)).toFixed(6);
  return `setpts=PTS/${speed},fps=30,scale=2560:1440:force_original_aspect_ratio=increase,crop=2560:1440,` +
    `zoompan=z='min(zoom+${inc},1.16)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':fps=30:s=${W}x${H},format=yuv420p`;
};

const browser = await chromium.launch();
async function card(params, ms, outMp4) {
  const recDir = mkdtempSync(join(tmpdir(), 'card-'));
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, recordVideo: { dir: recDir, size: { width: W, height: H } } });
  const page = await ctx.newPage();
  const qs = new URLSearchParams(params).toString();
  await page.goto('file://' + join(here, 'card.html') + '?' + qs);
  try { await page.evaluate(() => document.fonts.ready); } catch {}
  await page.waitForTimeout(250);
  await page.evaluate(() => document.querySelector('.dcard')?.classList.add('go'));
  await page.waitForTimeout(ms);
  const v = await page.video().path();
  await page.close(); await ctx.close();
  ff(`-i "${v}" -r 30 -s ${W}x${H} -pix_fmt yuv420p -c:v libx264 -crf 20 -an "${outMp4}"`);
  rmSync(recDir, { recursive: true, force: true });
}

async function buildOne(name) {
  const d = DEMOS[name];
  const t = mkdtempSync(join(tmpdir(), `demo-${name}-`));
  // hook + outro cards
  await card({ mode: 'hook', ...d.hook }, 3000, join(t, 'hook.mp4'));
  await card({ mode: 'outro', ...d.outro }, 3200, join(t, 'outro.mp4'));
  // footage bits (Ken Burns), then concat
  const segs = [];
  d.bits.forEach((b, i) => {
    const o = join(t, `seg${i}.mp4`);
    const pre = b.pre ? b.pre + ',' : '';
    const vf = pre + ken(b.speed, b.dur / b.speed);
    ff(`-ss ${b.start} -t ${b.dur} -i "${b.src}" -vf "${vf}" -an -c:v libx264 -crf 20 "${o}"`);
    segs.push(o);
  });
  let footage = segs[0];
  if (segs.length > 1) {
    const list = join(t, 'list.txt');
    execSync(`printf "${segs.map((s) => `file '${s}'\\n`).join('')}" > "${list}"`);
    footage = join(t, 'footage.mp4');
    ff(`-f concat -safe 0 -i "${list}" -c copy "${footage}"`);
  }
  // crossfade: hook -> footage -> outro
  const hookd = probe(join(t, 'hook.mp4'));
  const ab = join(t, 'ab.mp4');
  ff(`-i "${join(t, 'hook.mp4')}" -i "${footage}" -filter_complex "xfade=transition=fade:duration=0.5:offset=${(hookd - 0.5).toFixed(2)},format=yuv420p" -r 30 -an "${ab}"`);
  const abd = probe(ab);
  const out = join(OUT, `demo-${name}.mp4`);
  ff(`-i "${ab}" -i "${join(t, 'outro.mp4')}" -filter_complex "xfade=transition=fade:duration=0.5:offset=${(abd - 0.5).toFixed(2)},format=yuv420p" -r 30 -an -movflags +faststart "${out}"`);
  rmSync(t, { recursive: true, force: true });
  process.stdout.write(`✓ demo-${name}.mp4\n`);
}

const arg = process.argv[2];
const names = arg ? [arg] : Object.keys(DEMOS);
for (const n of names) { if (!DEMOS[n]) { process.stdout.write(`? unknown ${n}\n`); continue; } await buildOne(n); }
await browser.close();
process.stdout.write('\ndone\n');
