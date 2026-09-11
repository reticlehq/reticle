// Real-world Reticle coverage against the showcase dashboard (apps/bench-app on :4310 + apps/api on :8787).
// Exercises the full loop on a believable product UI: capability discovery → auth → live store
// state → routing → virtualized scroll-to-find → autonomous crawl. Plain synthetic input (no CDP),
// so it runs in the same lightweight battery as the other specs.
import { chromium } from 'playwright';
import {
  start, TOOLS, BaselineStore, RecordingStore, FlowStore, ProjectStore, AnnotationStore, createNodeFileSystem,
} from '@reticlehq/server';
import os from 'node:os';
import path from 'node:path';
import { waitForSession } from '../wait-for-session.mjs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const chk = (l, o, d = '') => { console.log(`   ${o ? '✅' : '❌'} ${l}${d ? '  — ' + d : ''}`); o ? pass++ : fail++; };

const reticleRoot = path.join(os.tmpdir(), `reticle-rw-${process.pid}`, '.reticle');
const fsp = createNodeFileSystem();
const now = () => Date.now();
const server = await start({ port: 4400, mcp: false });
const deps = {
  sessions: server.bridge.sessions, baselines: new BaselineStore(), recordings: new RecordingStore(),
  flows: new FlowStore(fsp, reticleRoot, { now }), project: new ProjectStore(fsp, reticleRoot, { now }),
  annotations: new AnnotationStore(), fs: fsp, reticleRoot, now,
};
const T = (n, a = {}) => TOOLS.find((t) => t.name === n).handler(deps, { sessionId: 'demo', ...a });
const refOf = async (by, value) => { for (let i = 0; i < 40; i++) { const r = (await T('reticle_query', { by, value })).elements?.[0]?.ref; if (r) return r; await sleep(100); } return null; };

const b = await chromium.launch({ headless: true });
const p = await b.newPage();
// `load`, not `networkidle`. A dev server with an HMR socket and lazy module requests can go a long
// time without 500ms of silence, so networkidle timed out under parallel load — a wait about the
// MACHINE, not about the app. The readiness that actually matters is the next line: the app's SDK
// dialing the bridge, which is app-specific and is what every assertion below depends on.
await p.goto('http://localhost:4310/?session=demo');
await waitForSession(()=>server.bridge.sessions.list(), 'demo');

console.log('\n=== Reticle × showcase dashboard (:4310) ===');
chk('dashboard SDK connected', server.bridge.sessions.list().some(s=>s.sessionId==='demo'));

const caps = await T('reticle_capabilities');
chk('reticle_capabilities advertises the testable surface', (caps.testids?.length ?? 0) >= 30 && caps.stores?.includes('app'), `${caps.testids?.length} testids, ${caps.signals?.length} signals`);

// Auth: click sign-in (pre-filled), wait for the auth signal → dashboard.
await T('reticle_act_and_wait', { ref: await refOf('testid', 'login-submit'), action: 'click', until: { kind: 'signal', name: 'auth:granted' }, timeout_ms: 5000 });
chk('login → auth:granted → dashboard', (await refOf('testid', 'nav-deployments')) !== null);

// State: read the live zustand store (the reliable cross-check layer).
const st = await T('reticle_state', { store: 'app' });
chk('reticle_state reads the live app store', JSON.stringify(st).includes('deployments'));

// Routing via signal.
await T('reticle_act_and_wait', { ref: await refOf('testid', 'nav-deployments'), action: 'click', until: { kind: 'signal', name: 'nav:changed' }, timeout_ms: 3000 });
chk('nav:changed → deployments table', (await refOf('testid', 'deploy-list')) !== null);

// Virtualized scroll-to-find.
const list = await refOf('testid', 'deploy-list');
const before = (await T('reticle_query', { by: 'testid', value: 'row-3965' })).elements?.length ?? 0;
const found = await T('reticle_scroll_to', { by: 'testid', value: 'row-3965', container: list, maxScrolls: 60 });
chk('reticle_scroll_to reveals a virtualized row', before === 0 && found.found === true, `scrolls=${found.scrolls}`);

// Autonomous crawl over the diagnostics controls.
await T('reticle_act_and_wait', { ref: await refOf('testid', 'nav-diagnostics'), action: 'click', until: { kind: 'signal', name: 'nav:changed' }, timeout_ms: 3000 });
await sleep(300);
const crawl = await T('reticle_verify', { action: 'crawl', maxSteps: 8, settleMs: 220 });
chk('reticle_crawl drives the controls + reports', crawl.stepsRun > 0, `clicked=${crawl.stepsRun}, anomalies=${crawl.anomalies.length}`);

// ── the VERDICT, end to end, in both directions ────────────────────────────────────────────────
//
// `verified` is the one field the tools tell an agent to read, and NOT ONE web spec asserted on it —
// so every rule feeding it (contradictions, accepted-but-unreconciled writes, unread payloads) was
// covered only by unit tests over synthetic events. Both directions are pinned below, because either
// alone is satisfiable by a broken rule: always-`no` catches the false green and cries wolf on
// everything else, always-`yes` is silent and green.
// Whatever named control this dashboard offers — the point is that a verdict comes back at all,
// not which button produced it. Pinned to the FIRST named button rather than a specific label, so
// this cannot silently skip itself into a pass if the fixture's copy changes.
const anyButton = (await T('reticle_query', { by: 'role', value: 'button', all: true })).elements?.find(
  (e) => (e.name ?? '').length > 0,
);
chk('the dashboard offers a named control to act on', anyButton !== undefined);
const acted = await T('reticle_act', {
  ref: anyButton.ref,
  action: 'click',
  args: { confirmDangerous: true },
});
await sleep(1200);
const v = await T('reticle_assert', {
  predicate: { kind: 'console', level: 'error', absent: true },
  since: acted.since,
});
chk(
  'a verdict is returned at all — reticle_assert carries `verified`, not just `pass`',
  typeof v.verified === 'string' && typeof v.because === 'string',
  `verified=${String(v.verified)}`,
);

// A plainly healthy read: nothing acted on, nothing failed, so the verdict must not hedge.
const clean = await T('reticle_assert', { predicate: { kind: 'console', level: 'error', absent: true } });
chk(
  'a clean window reads as verified, so the field still means something',
  clean.verified === 'yes',
  `verified=${String(clean.verified)} because=${String(clean.because ?? '').slice(0, 80)}`,
);

// The REFUSE direction, on a deliberately seeded false green: the generate call answers 500 and the
// app renders success anyway. A green `pass` here is correct and beside the point — what must hold is
// that the verdict refuses it and names why.
await p.goto('http://localhost:4310/?session=demo&reticle-bug=swallowed-500-generate');
await sleep(1500);
// A reload drops the session, and Compose sits behind auth — sign in again before reaching it.
await T('reticle_act_and_wait', {
  ref: await refOf('testid', 'login-submit'),
  action: 'click',
  until: { kind: 'signal', name: 'auth:granted' },
  timeout_ms: 5000,
});
const composeNav = await refOf('testid', 'nav-compose');
if (composeNav !== null) await T('reticle_act', { ref: composeNav, action: 'click' });
// The generate button is DISABLED until the prompt has content — clicking it empty fires no request
// at all, and the check then "passes" on an ordinary red instead of on a refused false green.
const promptRef = await refOf('testid', 'compose-prompt');
if (promptRef !== null) {
  await T('reticle_act', { ref: promptRef, action: 'fill', args: { value: 'ship notes' } });
}
const genRef = await refOf('testid', 'compose-generate');
// Reported, never thrown: a check that dies on a missing ref takes the whole spec with it and says
// nothing about the thing it was guarding.
chk('the seeded-bug run reaches the generate control', genRef !== null);
const gen =
  genRef === null ? { since: 0 } : await T('reticle_act', { ref: genRef, action: 'click' });
await sleep(1800);
const seeded = await T('reticle_assert', {
  // Measured: the request really answers 500 and `compose-result` never renders — so asserting on
  // THAT is an ordinary red. What the app still shows is the "generated" badge, and that is the
  // false green: a screen claiming success over a failed call.
  predicate: { kind: 'text', contains: 'generated' },
  since: gen.since,
});
// BOTH halves matter. `pass === true` is what makes this a false green rather than an ordinary red:
// the screen really did render success. `verified === 'no'` is the refusal. A check that accepted
// verified==='no' alone would pass on a plain failed assertion and prove nothing.
chk(
  'the verdict REFUSES a seeded false green (500 swallowed, UI renders success)',
  seeded.pass === true && seeded.verified === 'no',
  `pass=${String(seeded.pass)} verified=${String(seeded.verified)} because=${String(seeded.because ?? '').slice(0, 90)}`,
);

console.log(`\n${fail === 0 ? '✅ REAL-WORLD VERIFIED' : '❌ FAILED'} (${pass} passed, ${fail} failed)`);
await b.close();
await server.close();
process.exit(fail === 0 ? 0 : 1);
