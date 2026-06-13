// Real-browser proof of M5.7 status-honesty against apps/next-smoke (:3100).
// The key scenario: a THROTTLED tab where requestAnimationFrame never fires. We reproduce it
// by neutering rAF before page load (addInitScript) so the SDK's bound realRaf never resolves —
// exactly the condition that made iris_act hang to the 8s timeout and report a click as an error.
import { chromium } from 'playwright';
import { start, TOOLS, BaselineStore, RecordingStore } from '@syrin/server';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Number(process.hrtime.bigint() / 1000000n);
const deps = { sessions: null, baselines: new BaselineStore(), recordings: new RecordingStore() };
const SID = 'next-smoke';
const T = (n, a = {}) => TOOLS.find((t) => t.name === n).handler(deps, { sessionId: SID, ...a });
let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`   ${ok ? '✅' : '❌'} ${label}${detail ? `  — ${detail}` : ''}`);
  ok ? (pass += 1) : (fail += 1);
};
const refOf = async (by, value) => {
  for (let i = 0; i < 30; i++) {
    const r = (await T('iris_query', { by, value })).elements?.[0]?.ref;
    if (r) return r;
    await sleep(100);
  }
  throw new Error(`not found ${by}=${value}`);
};

const server = await start({ port: 4400, mcp: false });
deps.sessions = server.bridge.sessions;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
// THROTTLE SIMULATION: rAF never fires its callback (like a real background tab).
await page.addInitScript(() => {
  window.requestAnimationFrame = () => 0;
});
await page.goto('http://localhost:3100/', { waitUntil: 'networkidle' });
for (let i = 0; i < 150 && server.bridge.sessions.count() === 0; i++) await sleep(50);
console.log('\n=== M5.7 status honesty, real Chromium (rAF throttled) ===');

// F1 — act on a tab where rAF never fires must NOT hang/throw; returns dispatched:true fast.
const addRef = await refOf('testid', 'add-task');
const t0 = now();
let f1ok = false, f1detail = '';
try {
  const act = await T('iris_act', { ref: addRef, action: 'click' });
  const ms = now() - t0;
  const r = act.result ?? {};
  f1ok = act.dispatched === true && r.settled === false && r.settleReason === 'timeout' && ms < 4000;
  f1detail = `dispatched=${act.dispatched} settled=${r.settled} settleReason=${r.settleReason} in ${ms}ms (was 8000ms error)`;
} catch (e) {
  f1detail = `THREW: ${e instanceof Error ? e.message : String(e)}`;
}
check('F1 act on throttled tab returns dispatched:true (not an 8s error)', f1ok, f1detail);

// F2 — session health surfaces on the act result; hidden tab → throttled + warning.
await page.evaluate(() => {
  Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
  Object.defineProperty(document, 'hidden', { value: true, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
});
await sleep(300);
const act2 = await T('iris_act', { ref: await refOf('testid', 'add-task'), action: 'click' });
check('F2 act result carries session health', Boolean(act2.session) && typeof act2.session.lastSeenMs === 'number',
  JSON.stringify(act2.session ?? {}));
check('F2 hidden tab → throttled:true + warning', act2.session?.throttled === true && typeof act2.warning === 'string',
  act2.warning ?? '(no warning)');

// un-hide for the rest
await page.evaluate(() => {
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  Object.defineProperty(document, 'hidden', { value: false, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
});
await sleep(200);

// F4 — zero-match query returns a hint (empty-state vs missing), not a bare [].
const miss = await T('iris_query', { by: 'testid', value: 'definitely-not-here-xyz' });
const present = miss.hint?.presentTestids ?? [];
check('F4 zero-match query returns hint.presentTestids', miss.elements?.length === 0 && Array.isArray(present) && present.length > 0,
  `route=${miss.hint?.route ?? '?'} present=${JSON.stringify(present).slice(0, 70)}`);

// F5 — state{ref} returns a structured result, never hangs.
const t5 = now();
let f5ok = false, f5detail = '';
try {
  const st = await T('iris_state', { ref: addRef });
  const ms = now() - t5;
  f5ok = ms < 4000 && st !== undefined; // resolves (value or {ok:false,reason}) — does not hang
  f5detail = `${JSON.stringify(st).slice(0, 80)} in ${ms}ms`;
} catch (e) {
  f5detail = `THREW: ${e instanceof Error ? e.message : String(e)}`;
}
check('F5 state{ref} resolves with structured status (no hang)', f5ok, f5detail);

console.log(`\n${fail === 0 ? '✅ M5.7 STATUS HONESTY PASSED' : `❌ ${fail} FAILED`}  (${pass} passed, ${fail} failed)`);
await browser.close();
await server.close();
process.exit(fail === 0 ? 0 : 1);
