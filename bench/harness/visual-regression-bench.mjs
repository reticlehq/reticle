// Visual-regression — the honest REVERSE case (where a screenshot tool wins). A paint-level
// regression (a stray `filter` re-tints the whole rendered page) changes the PIXELS but none of the
// element props iris_inspect surfaces (color/backgroundColor/opacity/box/cursor are the declared
// values; the filter only alters paint). So:
//   - Iris always-on iris_inspect  → MISSES (computed-style props unchanged).
//   - A screenshot-diff            → CATCHES (the rendered frame changed) — Playwright's native
//                                     toHaveScreenshot idiom, and Iris's OWN opt-in visual layer
//                                     (iris drive + iris_visual_diff), which we use here to measure it.
// Honest verdict: blind visual-regression is the screenshot's home turf. Playwright does it natively;
// Iris does it only when DRIVEN (the always-on SDK is computed-style, not pixels).
import { writeFileSync } from 'node:fs';
import { IrisAdapter } from './adapters.mjs';

const BASE = process.env.BENCH_URL ?? 'http://localhost:4312/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const url = (bug) => (bug ? `${BASE}${BASE.includes('?') ? '&' : '?'}iris-bug=${bug}` : BASE);
const parse = (t) => {
  try {
    return JSON.parse(t || '{}');
  } catch {
    return {};
  }
};

// iris_inspect signals that a paint-only regression must NOT change (proving inspect is blind to it).
const inspectSignals = (ins) => ({
  color: ins.styles?.color ?? null,
  backgroundColor: ins.styles?.backgroundColor ?? null,
  opacity: ins.styles?.opacity ?? null,
  box: ins.box ? `${ins.box.width}x${ins.box.height}` : null,
});

async function inspectBrand(a) {
  const q = parse((await a.c.callTool('iris_query', { by: 'testid', value: 'brand' })).text);
  const ref = (q.elements ?? [])[0]?.ref;
  if (!ref) return null;
  return inspectSignals(parse((await a.c.callTool('iris_inspect', { ref })).text));
}

// (1) Clean page: save a visual baseline + record the brand's inspect signals.
const clean = await (async () => {
  const a = new IrisAdapter(url(null));
  await a.start();
  try {
    await a.login();
    await sleep(500);
    await a.c.callTool('iris_screenshot', { name: 'vr-base' });
    return { signals: await inspectBrand(a) };
  } finally {
    await a.stop();
  }
})();

// (2) Bugged page: screenshot-diff vs the baseline + re-read the brand's inspect signals.
const bugged = await (async () => {
  const a = new IrisAdapter(url('paint-filter'));
  await a.start();
  try {
    await a.login();
    await sleep(500);
    const diff = parse((await a.c.callTool('iris_visual_diff', { baseline: 'vr-base' })).text);
    return { diff, signals: await inspectBrand(a) };
  } finally {
    await a.stop();
  }
})();

const screenshotCaught = bugged.diff?.ok === true && bugged.diff?.matched === false;
const inspectSame = JSON.stringify(clean.signals) === JSON.stringify(bugged.signals);
const summary = {
  dimension: 'Visual regression (paint-level) — the honest reverse case (screenshot wins)',
  scenario: 'a stray CSS filter re-tints the whole rendered page (?iris-bug=paint-filter)',
  screenshot_diff: {
    caught: screenshotCaught,
    ratio: bugged.diff?.ratio ?? null,
    changedPixels: bugged.diff?.changedPixels ?? null,
    note: 'Iris opt-in visual layer (iris_visual_diff) — same mechanism as Playwright toHaveScreenshot',
  },
  always_on_inspect: {
    caught: !inspectSame,
    clean_signals: clean.signals,
    bugged_signals: bugged.signals,
    note: 'iris_inspect computed-style props — unchanged by a paint-only filter, so it MISSES the regression',
  },
  honest_verdict:
    'Blind visual regression is the screenshot-diff’s strength: Playwright catches it natively, and Iris catches it only when DRIVEN (its opt-in visual layer). The always-on computed-style read misses paint-level changes.',
};
writeFileSync('bench/raw/visual-regression-bench.json', JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
console.log(
  `\n=== visual-regression: screenshot-diff ${screenshotCaught ? 'CAUGHT' : 'missed'} (ratio=${bugged.diff?.ratio}) | always-on inspect ${inspectSame ? 'MISSED (signals identical)' : 'changed'} — honest reverse: screenshot/Playwright wins, Iris needs driving ===`,
);
process.exit(0);
