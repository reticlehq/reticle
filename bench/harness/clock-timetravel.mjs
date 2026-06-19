// Time-travel (Iris-only capability): verify a TIME-GATED flow at clock speed, not wall-clock speed.
//
// The demo's createDeployment sets a new deployment to status 'building', then a 2600ms setTimeout
// flips it to 'live'. Iris patches the app's setTimeout/Date, so it can FREEZE the clock, run the
// action, ADVANCE 2600ms, and verify 'live' — deterministically and instantly (no real waiting).
//
// Playwright / DevTools cannot control the app's timers: to see the transition they must sleep
// through real wall-clock time (≥2600ms) and GUESS the duration — under-wait → flaky miss, over-wait
// → slow. The timer duration is their structural floor; Iris's is ~0. We show both paths with Iris:
//   (a) clock-advanced: freeze → submit → advance 2600 → assert 'live'  (instant, exact)
//   (b) real-wait:      submit → sleep 2600 → assert 'live'             (the floor any outside tool pays)
import { writeFileSync } from 'node:fs';
import { IrisAdapter } from './adapters.mjs';
import { measure } from './tokenizer.mjs';

const URL = process.env.BENCH_URL ?? 'http://localhost:4312/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TIMER_MS = 2600; // createDeployment building→live delay (the competitor's real-wait floor)

const parse = (t) => {
  try {
    return JSON.parse(t || '{}');
  } catch {
    return {};
  }
};
const monotonic = () => Number(process.hrtime.bigint() / 1000000n);

async function fill(a, testid, value) {
  const q = await a._refByTestid(testid);
  if (q.ref) await a.c.callTool('iris_act', { ref: q.ref, action: 'fill', args: { value } });
}
// `new-deploy` / `deploy-submit` trip Iris's destructive-action guard (a deploy is consequential),
// so the click needs explicit confirmation — itself an Iris-only safety the harness opts through.
async function clickConfirm(a, testid) {
  await a._waitForTestid(testid, 6000);
  const q = await a._refByTestid(testid);
  if (q.ref) {
    await a.c.callTool('iris_act', {
      ref: q.ref,
      action: 'click',
      args: { confirmDangerous: true },
    });
  }
}
async function statusOfTop(a) {
  const st = await a.c.callTool('iris_state', { store: 'app', path: 'deployments.0.status' });
  return {
    value: String(parse(st.text).value ?? '').toLowerCase(),
    tokens: measure(st.text ?? '').tokens_o200k,
  };
}

async function run() {
  // (a) Clock-advanced: deterministic, instant.
  const advanced = await (async () => {
    const a = new IrisAdapter(URL);
    await a.start();
    try {
      await a.login();
      await a.gotoView('deployments');
      await clickConfirm(a, 'new-deploy');
      await sleep(300);
      await fill(a, 'deploy-name', 'clock-travel-svc');
      // Freeze BEFORE submit so createDeployment's setTimeout lands in the fake queue.
      await a.c.callTool('iris_clock', { freeze: true });
      await clickConfirm(a, 'deploy-submit');
      await sleep(150);
      const t0 = monotonic();
      await a.c.callTool('iris_clock', { advanceMs: TIMER_MS });
      const s = await statusOfTop(a);
      const elapsed = monotonic() - t0;
      await a.c.callTool('iris_clock', { reset: true });
      return { live: s.value === 'live', status: s.value, wall_ms: elapsed, tokens: s.tokens };
    } finally {
      await a.stop();
    }
  })();

  // (b) Real-wait: the floor any outside-the-page tool must pay to observe the same transition.
  const realWait = await (async () => {
    const a = new IrisAdapter(URL);
    await a.start();
    try {
      await a.login();
      await a.gotoView('deployments');
      await clickConfirm(a, 'new-deploy');
      await sleep(300);
      await fill(a, 'deploy-name', 'real-wait-svc');
      await clickConfirm(a, 'deploy-submit');
      const t0 = monotonic();
      await sleep(TIMER_MS + 200);
      const s = await statusOfTop(a);
      const elapsed = monotonic() - t0;
      return { live: s.value === 'live', status: s.value, wall_ms: elapsed };
    } finally {
      await a.stop();
    }
  })();

  return { advanced, realWait };
}

const r = await run();
const speedup = r.advanced.wall_ms > 0 ? Math.round(r.realWait.wall_ms / r.advanced.wall_ms) : null;
const summary = {
  dimension: 'Time-travel — verify a time-gated flow via the app clock (Iris-only)',
  scenario: 'createDeployment: status building→live after a 2600ms setTimeout',
  iris_clock_advanced: r.advanced,
  real_wait_floor: r.realWait,
  competitor_floor_ms: TIMER_MS,
  speedup_vs_realwait: speedup,
  note: 'Iris freezes the app clock, runs the action, advances exactly 2600ms, and verifies the transition with no real time elapsed — deterministic. Playwright/DevTools cannot control the app timers; they must sleep through ≥2600ms of real wall-clock and guess the duration (under-wait = flaky miss). The timer duration is their structural floor.',
};
writeFileSync('bench/raw/clock-timetravel.json', JSON.stringify(summary, null, 2));
console.log(JSON.stringify(r.advanced), JSON.stringify(r.realWait));
console.log(
  `\n=== time-travel: Iris verifies building→live in ~${r.advanced.wall_ms}ms via clock-advance (status=${r.advanced.status}) vs ~${r.realWait.wall_ms}ms real-wait floor => ${speedup}x faster, deterministic ===`,
);
process.exit(0);
