// Drive the real Next.js app (apps/next-smoke, :3100) with Iris to de-risk Next.
import { chromium } from 'playwright';
import { start, TOOLS, BaselineStore, RecordingStore } from '@syrin/iris-server';

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
    const r = (await T('iris_query', name ? { by, value, name } : { by, value })).elements[0]?.ref;
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

console.log('\n=== Iris on a real Next.js 15 / React 19 app ===');
check('Iris session connected from Next', server.bridge.sessions.count() >= 1,
  JSON.stringify((await T('iris_sessions')).sessions.map((s) => s.sessionId)));

const snap = await T('iris_snapshot', { mode: 'interactive' });
console.log('\n— interactive snapshot —\n' + snap.tree + '\n');
check('snapshot sees the buttons', /ping-button|Call \/api\/ping|Add task/.test(snap.tree) || snap.tree.includes('button'));

console.log('TASK A — client state update (add a task)');
await T('iris_act', { ref: await refOf('testid', 'add-task'), action: 'click' });
const added = await T('iris_assert', {
  timeout_ms: 2000,
  predicate: { kind: 'element', query: { text: 'Task 2', scope: '[data-testid="task-list"]' }, state: 'visible' },
});
check('new task rendered after click', added.pass, added.failureReason ?? '');

console.log('\nTASK B — API call (Next route handler) + modal + no console errors');
const since = (await T('iris_act', { ref: await refOf('testid', 'ping-button'), action: 'click' })).since;
const verdict = await T('iris_assert', {
  timeout_ms: 10000,
  predicate: { kind: 'allOf', predicates: [
    { kind: 'net', method: 'GET', urlContains: '/api/ping', status: 200, since },
    { kind: 'element', query: { role: 'dialog', name: 'Server reply' }, state: 'visible' },
    { kind: 'text', contains: 'pong', visible: true },
    { kind: 'console', level: 'error', absent: true },
  ]},
});
check('GET /api/ping 200 + modal visible + "pong" + no console errors', verdict.pass, verdict.failureReason ?? '');

console.log('\nTASK C — component identity via @syrin/iris-react (Next + SWC)');
const info = await T('iris_inspect', { ref: await refOf('testid', 'ping-button') });
check('component identity resolved', Array.isArray(info.component?.componentStack) && info.component.componentStack.length > 0,
  info.component ? info.component.componentStack.join(' < ') : 'none');
console.log(`   ℹ source file: ${info.component?.source ? `${info.component.source.file}:${info.component.source.line}` : 'n/a — Next uses SWC; needs the SWC source plugin (roadmap)'}`);

console.log(`\n${fail === 0 ? '✅ NEXT.JS SMOKE TEST PASSED' : `❌ ${fail} FAILED`}  (${pass} passed, ${fail} failed)`);
await browser.close();
await server.close();
process.exit(fail === 0 ? 0 : 1);
