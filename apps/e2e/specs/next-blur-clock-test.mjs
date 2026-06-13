// Real-browser e2e proving M5.5 #1 (synthetic blur -> React onBlur commit) and #3 (fake
// clock advances a time-gated toast) against the real Next.js app on :3100.
import { chromium } from 'playwright';
import { start, TOOLS, BaselineStore, RecordingStore } from '@iris/server';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
    const r = (await T('iris_query', { by, value })).elements[0]?.ref;
    if (r) return r;
    await sleep(100);
  }
  throw new Error(`not found ${by}=${value}`);
};

const server = await start({ port: 4400, mcp: false });
deps.sessions = server.bridge.sessions;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto('http://localhost:3100/', { waitUntil: 'networkidle' });
for (let i = 0; i < 150 && server.bridge.sessions.count() === 0; i++) await sleep(50);
console.log('\n=== blur + fake-clock, real Chromium / Next.js ===');

// TEST 1 — synthetic blur triggers React onBlur (commit-on-blur)
const field = await refOf('testid', 'edit-field');
await T('iris_act', { ref: field, action: 'fill', args: { value: 'Hello Iris' } });
const since = (await T('iris_act', { ref: field, action: 'blur' })).since;
const committed = await T('iris_assert', {
  timeout_ms: 2000,
  predicate: { kind: 'allOf', predicates: [
    { kind: 'signal', name: 'field:committed', dataMatches: { value: 'Hello Iris' }, since },
    { kind: 'text', contains: 'Committed: Hello Iris', visible: true },
  ]},
});
check('synthetic blur fired React onBlur (commit-on-blur)', committed.pass, committed.failureReason ?? '');

// TEST 2 — fake clock advances a time-gated auto-dismiss toast
await T('iris_clock', { freeze: true });
await T('iris_act', { ref: await refOf('testid', 'show-toast'), action: 'click' });
const shown = await T('iris_assert', {
  timeout_ms: 2000,
  predicate: { kind: 'element', query: { testid: 'toast' }, state: 'visible' },
});
check('toast visible after click (clock frozen)', shown.pass, shown.failureReason ?? '');
await T('iris_clock', { advanceMs: 4000 });
await sleep(250);
const gone = await T('iris_assert', {
  timeout_ms: 2000,
  predicate: { kind: 'element', query: { testid: 'toast' }, absent: true },
});
check('toast auto-dismissed after advancing 4s (no real wait)', gone.pass, gone.failureReason ?? '');
await T('iris_clock', { reset: true });

console.log(`\n${fail === 0 ? '✅ BLUR + CLOCK E2E PASSED' : `❌ ${fail} FAILED`}  (${pass} passed, ${fail} failed)`);
await browser.close();
await server.close();
process.exit(fail === 0 ? 0 : 1);
