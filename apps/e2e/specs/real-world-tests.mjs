// Real-world Iris tests against the complex dashboard (apps/demo + apps/api).
// Prereqs (run these first, in other terminals):
//   REFLECT_MS=6000 node apps/api/server.mjs
//   pnpm --filter @iris/demo dev
// Then: node plan/real-world-tests.mjs
import { chromium } from 'playwright';
import { start, TOOLS, BaselineStore, RecordingStore } from '@iris/server';

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const deps = { sessions: null, baselines: new BaselineStore(), recordings: new RecordingStore() };
const T = (name, args = {}) => TOOLS.find((t) => t.name === name).handler(deps, args);

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
  log(`   ${ok ? '✅' : '❌'} ${label}${detail ? `  — ${detail}` : ''}`);
  ok ? (pass += 1) : (fail += 1);
};
const LIST = '[data-testid="item-list"]';
const refOf = async (by, value, name) => {
  for (let i = 0; i < 30; i++) {
    const r = (await T('iris_query', name ? { by, value, name } : { by, value })).elements[0]?.ref;
    if (r) return r;
    await sleep(100);
  }
  throw new Error(`element not found: ${by}=${value}${name ? ` name=${name}` : ''}`);
};

const server = await start({ port: 4400, mcp: false });
deps.sessions = server.bridge.sessions;
const browser = await chromium.launch({ headless: false, slowMo: 250 });
const page = await browser.newPage();
await page.goto('http://localhost:3000/?noagentation', { waitUntil: 'networkidle' });
for (let i = 0; i < 100 && server.bridge.sessions.count() === 0; i++) await sleep(50);
log(`✓ Iris connected to the live app (session ${JSON.stringify((await T('iris_sessions')).sessions.map((s) => s.sessionId))})\n`);

// ── TASK 1: Login form with authorization ────────────────────────────────
log('TASK 1 — login form: wrong creds rejected, correct creds grant access');
const emailRef = await refOf('testid', 'login-email');
await T('iris_act', { ref: emailRef, action: 'fill', args: { value: 'wrong@nope.com' } });
await T('iris_act', { ref: await refOf('testid', 'login-password'), action: 'fill', args: { value: 'bad' } });
let since = (await T('iris_act', { ref: await refOf('testid', 'login-submit'), action: 'click' })).since;
const badLogin = await T('iris_assert', {
  timeout_ms: 2000,
  predicate: { kind: 'allOf', predicates: [
    { kind: 'net', urlContains: '/api/login', status: 401, since },
    { kind: 'element', query: { role: 'alert' }, state: 'visible' },
  ]},
});
check('wrong credentials → 401 + error shown', badLogin.pass, badLogin.failureReason ?? '');

await T('iris_act', { ref: await refOf('testid', 'login-email'), action: 'fill', args: { value: 'admin@iris.dev' } });
await T('iris_act', { ref: await refOf('testid', 'login-password'), action: 'fill', args: { value: 'password' } });
since = (await T('iris_act', { ref: await refOf('testid', 'login-submit'), action: 'click' })).since;
const goodLogin = await T('iris_assert', {
  timeout_ms: 3000,
  predicate: { kind: 'allOf', predicates: [
    { kind: 'net', method: 'POST', urlContains: '/api/login', status: 200, since },
    { kind: 'element', query: { role: 'tab', name: 'Items' }, state: 'visible' },
  ]},
});
check('correct credentials → 200 + dashboard visible', goodLogin.pass, goodLogin.failureReason ?? '');

// ── TASK 2: find one element among 1000s ─────────────────────────────────
log('\nTASK 2 — find a specific item among 1000 (no scrolling/eyeballing)');
const found777 = await T('iris_assert', {
  timeout_ms: 4000,
  predicate: { kind: 'element', query: { text: 'Item 777', scope: LIST }, state: 'visible' },
});
check('"Item 777" found in the 1000-item list', found777.pass, found777.failureReason ?? '');
const ghost = await T('iris_assert', {
  predicate: { kind: 'element', query: { text: 'Item 4242', scope: LIST }, absent: true },
});
check('non-existent "Item 4242" correctly reported absent', ghost.pass, ghost.failureReason ?? '');

// ── TASK 3: server add reflected only after a delay → refresh to see ──────
log('\nTASK 3 — add to server (eventually consistent): not there now, appears after refresh');
const uniqueName = `Delayed-Item-${Date.now()}`; // unique per run (server store persists across runs)
await T('iris_act', { ref: await refOf('testid', 'add-item-input'), action: 'fill', args: { value: uniqueName } });
since = (await T('iris_act', { ref: await refOf('testid', 'add-item-button'), action: 'click' })).since;
const accepted = await T('iris_assert', {
  timeout_ms: 2000,
  predicate: { kind: 'net', method: 'POST', urlContains: '/api/items', status: 202, since },
});
check('POST accepted (202)', accepted.pass, accepted.failureReason ?? '');
const notYet = await T('iris_assert', {
  predicate: { kind: 'element', query: { text: uniqueName, scope: LIST }, absent: true },
});
check('item NOT in the list yet (eventual consistency)', notYet.pass, notYet.failureReason ?? '');
log('   …waiting 6.5s for the server to reflect it, then Refresh…');
await sleep(6500);
await T('iris_act', { ref: await refOf('testid', 'refresh-items'), action: 'click' });
const appeared = await T('iris_assert', {
  timeout_ms: 3000,
  predicate: { kind: 'element', query: { text: uniqueName, scope: LIST }, state: 'visible' },
});
check('after refresh, the item appears', appeared.pass, appeared.failureReason ?? '');

// ── TASK 4: click in one section → element appears in another ─────────────
log('\nTASK 4 — click in Items → notification appears in the Notifications section');
await T('iris_act', { ref: await refOf('testid', 'add-item-input'), action: 'fill', args: { value: 'Buy milk' } });
await T('iris_act', { ref: await refOf('testid', 'notify-button'), action: 'click' });
await T('iris_act', { ref: await refOf('testid', 'tab-notifications'), action: 'click' });
const crossSection = await T('iris_assert', {
  timeout_ms: 2000,
  predicate: { kind: 'text', contains: 'Buy milk', visible: true },
});
check('notification shows in the other section', crossSection.pass, crossSection.failureReason ?? '');

// ── TASK 5: broken endpoints surface real errors ─────────────────────────
log('\nTASK 5 — broken endpoints surface the right failures');
await T('iris_act', { ref: await refOf('testid', 'tab-errors'), action: 'click' });
since = (await T('iris_act', { ref: await refOf('testid', 'broken-404'), action: 'click' })).since;
const e404 = await T('iris_assert', { timeout_ms: 2000, predicate: { kind: 'net', urlContains: '/broken/404', status: 404, since } });
check('404 endpoint observed as 404', e404.pass, e404.failureReason ?? '');
since = (await T('iris_act', { ref: await refOf('testid', 'broken-500'), action: 'click' })).since;
const e500 = await T('iris_assert', { timeout_ms: 2000, predicate: { kind: 'net', urlContains: '/broken/500', status: 500, since } });
check('500 endpoint observed as 500', e500.pass, e500.failureReason ?? '');
since = (await T('iris_act', { ref: await refOf('testid', 'broken-wrong-format'), action: 'click' })).since;
const eFmt = await T('iris_assert', { timeout_ms: 2500, predicate: { kind: 'console', level: 'error', since } });
check('wrong-format (HTML not JSON) → console error', eFmt.pass, eFmt.failureReason ?? '');
since = (await T('iris_act', { ref: await refOf('testid', 'broken-cors'), action: 'click' })).since;
await sleep(800);
const corsReport = await T('iris_observe', { since, filters: ['console.error', 'error.uncaught', 'net.request'] });
check('CORS-blocked call produced an error', corsReport.summary.consoleErrors > 0 || corsReport.events.some((e) => e.data.ok === false),
  `consoleErrors=${corsReport.summary.consoleErrors}`);

// ── TASK 6: real (or mock) LLM call to generate a script ─────────────────
log('\nTASK 6 — LLM script generation: call fires, result renders');
await T('iris_act', { ref: await refOf('testid', 'tab-generate'), action: 'click' });
since = (await T('iris_act', { ref: await refOf('testid', 'generate-button'), action: 'click' })).since;
const llm = await T('iris_assert', {
  timeout_ms: 8000,
  predicate: { kind: 'allOf', predicates: [
    { kind: 'net', method: 'POST', urlContains: '/api/generate-script', status: 200, since },
    { kind: 'element', query: { testid: 'script-output' }, state: 'visible' },
  ]},
});
check('LLM call returned 200 and script rendered', llm.pass, llm.failureReason ?? '');

// ── TASK 7: hover changes the button color ───────────────────────────────
log('\nTASK 7 — button color changes on hover (computed style)');
const hoverRef = await refOf('testid', 'hover-button');
const before = (await T('iris_inspect', { ref: hoverRef })).styles?.backgroundColor;
await T('iris_act', { ref: hoverRef, action: 'hover' });
await sleep(250);
const inspAfter = await T('iris_inspect', { ref: hoverRef });
const after = inspAfter.styles?.backgroundColor;
check('background color changed on hover', before !== after && Boolean(after), `${before} → ${after}`);
const src = inspAfter.component?.source;
check('inspect resolves the source file (file:line via @iris/babel-plugin)',
  typeof src?.file === 'string', src ? `${src.file}:${src.line}` : 'none');

// ── TASK 8: attach a file → LLM → score modal ────────────────────────────
log('\nTASK 8 — attach a file → score modal shows a score');
await T('iris_act', { ref: await refOf('testid', 'tab-score'), action: 'click' });
await T('iris_act', { ref: await refOf('testid', 'file-input'), action: 'upload', args: { name: 'pitch.mp4', content: 'video bytes', type: 'video/mp4' } });
since = (await T('iris_act', { ref: await refOf('testid', 'analyze-button'), action: 'click' })).since;
const scored = await T('iris_assert', {
  timeout_ms: 8000,
  predicate: { kind: 'allOf', predicates: [
    { kind: 'net', method: 'POST', urlContains: '/api/score', status: 200, since },
    { kind: 'element', query: { role: 'dialog', name: 'Score result' }, state: 'visible' },
    { kind: 'text', contains: '/ 100', visible: true },
  ]},
});
check('file scored and the score modal is visible', scored.pass, scored.failureReason ?? '');

log(`\n${fail === 0 ? '✅ ALL REAL-WORLD TASKS PASSED' : `❌ ${fail} FAILED`}  (${pass} passed, ${fail} failed)`);
log('Leaving the browser open 6s so you can watch…');
await sleep(6000);
await browser.close();
await server.close();
process.exit(fail === 0 ? 0 : 1);
