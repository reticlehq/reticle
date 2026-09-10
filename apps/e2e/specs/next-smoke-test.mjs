// Drive the real Next.js app (apps/next-smoke, :3100) with Reticle to de-risk Next.
import { chromium } from 'playwright';
import { start, TOOLS, BaselineStore, RecordingStore } from '@reticlehq/server';
import { waitForSession } from '../wait-for-session.mjs';
import { waitUntil } from '../wait-until.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const deps = { sessions: null, baselines: new BaselineStore(), recordings: new RecordingStore() };
const SID = 'next-smoke';
const T = (n, a = {}) => TOOLS.find((t) => t.name === n).handler(deps, { sessionId: SID, ...a });
let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`   ${ok ? '✅' : '❌'} ${label}${detail ? `  — ${detail}` : ''}`);
  ok ? (pass += 1) : (fail += 1);
};
const refOf = async (by, value, name) => {
  for (let i = 0; i < 30; i++) {
    const r = (await T('reticle_query', name ? { by, value, name } : { by, value })).elements[0]?.ref;
    if (r) return r;
    await sleep(100);
  }
  throw new Error(`not found ${by}=${value}`);
};

const server = await start({ port: 4400, mcp: false });
deps.sessions = server.bridge.sessions;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto('http://localhost:3100/');
await waitForSession(()=>server.bridge.sessions.list(), 'next-smoke');

console.log('\n=== Reticle on a real Next.js 15 / React 19 app ===');
check('Reticle session connected from Next', server.bridge.sessions.list().some(s=>s.sessionId==='next-smoke'),
  JSON.stringify((await T('reticle_sessions')).sessions.map((s) => s.sessionId)));

const snap = await T('reticle_snapshot', { mode: 'interactive' });
console.log('\n— interactive snapshot —\n' + snap.tree + '\n');
check('snapshot sees the buttons', /ping-button|Call \/api\/ping|Add task/.test(snap.tree) || snap.tree.includes('button'));

console.log('TASK A — client state update (add a task)');
await T('reticle_act', { ref: await refOf('testid', 'add-task'), action: 'click' });
const added = await T('reticle_assert', {
  timeout_ms: 2000,
  predicate: { kind: 'element', query: { text: 'Task 2', scope: '[data-testid="task-list"]' }, state: 'visible' },
});
check('new task rendered after click', added.pass, added.failureReason ?? '');

console.log('\nTASK B — API call (Next route handler) + modal + no console errors');
const since = (await T('reticle_act', { ref: await refOf('testid', 'ping-button'), action: 'click' })).since;
const verdict = await T('reticle_assert', {
  timeout_ms: 10000,
  predicate: { kind: 'allOf', predicates: [
    { kind: 'net', method: 'GET', urlContains: '/api/ping', status: 200, since },
    { kind: 'element', query: { role: 'dialog', name: 'Server reply' }, state: 'visible' },
    { kind: 'text', contains: 'pong', visible: true },
    { kind: 'console', level: 'error', absent: true },
  ]},
});
check('GET /api/ping 200 + modal visible + "pong" + no console errors', verdict.pass, verdict.failureReason ?? '');

console.log('\nTASK C — component identity via @reticlehq/react (Next + SWC)');
const info = await T('reticle_inspect', { ref: await refOf('testid', 'ping-button') });
check('component identity resolved', Array.isArray(info.component?.componentStack) && info.component.componentStack.length > 0,
  info.component ? info.component.componentStack.join(' < ') : 'none');
console.log(`   ℹ source file: ${info.component?.source ? `${info.component.source.file}:${info.component.source.line}` : 'n/a — Next uses SWC; needs the SWC source plugin (roadmap)'}`);

console.log('\nTASK D — a SERVER ACTION, the mutation shape with no fetch the app wrote itself');
// Reticle's network picture comes from patching fetch/XHR in the page. A server action is neither in
// the app's code: React posts to the CURRENT url with a `Next-Action` header and an RSC response, not
// JSON. If that write were invisible, every server-action app would have its entire mutation surface
// unobserved — the desktop-IPC blind spot in a different costume. The fixture at app/actions has
// asked this question since it was written and no gate ever answered it.
await page.goto('http://localhost:3100/actions', { waitUntil: 'domcontentloaded' });
// A route change drops the page's SDK and it dials back; `domcontentloaded` says nothing about that.
// Wait for the route's OWN content to be queryable — which is the thing the next line needs — rather
// than for 1500ms, which is a statement about how fast `next dev` compiles a route on this machine.
const countBefore = await waitUntil(
  async () => (await T('reticle_query', { by: 'testid', value: 'note-count' })).elements?.[0]?.text,
);
await T('reticle_act', { ref: await refOf('testid', 'note-input'), action: 'fill', args: { value: 'from the battery' } });
const acted = await T('reticle_act', { ref: await refOf('testid', 'save-note'), action: 'click' });
// The server action's POST is exactly what the check below looks for, so wait for it to be OBSERVED.
// 2000ms was the guess; a cold `next dev` route compiles slower than that and the check then reads
// "a server action is silently missed" — a product accusation manufactured by a timer.
const saCalls =
  (await waitUntil(async () => {
    const calls = (await T('reticle_network', { since: acted.since })).calls ?? [];
    return calls.some((c) => c.method === 'POST' && String(c.url).includes('/actions'))
      ? calls
      : undefined;
  })) ?? (await T('reticle_network', { since: acted.since })).calls ?? [];
check(
  'a server action is OBSERVED as a network write, not silently missed',
  saCalls.some((c) => c.method === 'POST' && String(c.url).includes('/actions')),
  saCalls.map((c) => `${c.method} ${String(c.url).replace(/^https?:\/\/[^/]+/, '')} -> ${c.status}`).join(', ') || 'no calls seen',
);
// Wait for the CONSEQUENCE, not for the observation. The check above waits for the POST to be
// OBSERVED, which happens when the request STARTS — its status is still `pending` at that moment.
// Reading the count right then races the server action's round trip and the revalidate that follows
// it, and the race is won or lost on how loaded the machine is. It read `0 notes -> 0 notes` here
// while the very same page served `1 notes` three seconds later, which is the same "product
// accusation manufactured by a timer" the comment above already warns about, one level up.
const countAfter =
  (await waitUntil(async () => {
    const now = (await T('reticle_query', { by: 'testid', value: 'note-count' })).elements?.[0]?.text;
    return now !== countBefore ? now : undefined;
  })) ?? (await T('reticle_query', { by: 'testid', value: 'note-count' })).elements?.[0]?.text;
check('and the write really landed on the server', countBefore !== countAfter, `${String(countBefore)} -> ${String(countAfter)}`);

console.log(`\n${fail === 0 ? '✅ NEXT.JS SMOKE TEST PASSED' : `❌ ${fail} FAILED`}  (${pass} passed, ${fail} failed)`);
await browser.close();
await server.close();
process.exit(fail === 0 ? 0 : 1);
