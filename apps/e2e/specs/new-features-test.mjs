// Live verification of the features added in the [Unreleased] CHANGELOG section, against the real
// showcase dashboard (apps/demo :4310 + apps/api :8787). The existing battery proves no regression;
// this spec positively exercises the NEW surfaces end-to-end in a real browser:
//   - settled predicate + reticle_act_and_wait auto-settle (incl. the ambient-animation fix: the demo's
//     count-up counters emit dom.text every frame, which must NOT prevent settling)
//   - reticle_query limit / count_only token controls
//   - reticle_assert presence-only `advice` nudge
import { chromium } from 'playwright';
import {
  start,
  TOOLS,
  BaselineStore,
  RecordingStore,
  FlowStore,
  ProjectStore,
  AnnotationStore,
  createNodeFileSystem,
} from '@reticlehq/server';
import os from 'node:os';
import path from 'node:path';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0,
  fail = 0;
const chk = (l, o, d = '') => {
  console.log(`   ${o ? '✅' : '❌'} ${l}${d ? '  — ' + d : ''}`);
  o ? pass++ : fail++;
};

const reticleRoot = path.join(os.tmpdir(), `reticle-nf-${process.pid}`, '.reticle');
const fsp = createNodeFileSystem();
const now = () => Date.now();
const server = await start({ port: 4400, mcp: false });
const deps = {
  sessions: server.bridge.sessions,
  baselines: new BaselineStore(),
  recordings: new RecordingStore(),
  flows: new FlowStore(fsp, reticleRoot, { now }),
  project: new ProjectStore(fsp, reticleRoot, { now }),
  annotations: new AnnotationStore(),
  fs: fsp,
  reticleRoot,
  now,
};
const T = (n, a = {}) => TOOLS.find((t) => t.name === n).handler(deps, { sessionId: 'demo', ...a });
const refOf = async (by, value) => {
  for (let i = 0; i < 40; i++) {
    const r = (await T('reticle_query', { by, value })).elements?.[0]?.ref;
    if (r) return r;
    await sleep(100);
  }
  return null;
};

const b = await chromium.launch({ headless: true });
const p = await b.newPage();
await p.goto('http://localhost:4310/?session=demo', { waitUntil: 'networkidle' });
for (let i = 0; i < 200 && server.bridge.sessions.count() === 0; i++) await sleep(50);

console.log('\n=== Reticle × new features (:4310) ===');
chk('dashboard SDK connected', server.bridge.sessions.count() > 0);

// count_only — just the match count, no descriptors.
const co = await T('reticle_query', { by: 'role', value: 'button', count_only: true });
chk('reticle_query count_only returns a count, drops elements', typeof co.count === 'number' && co.count >= 1 && co.elements === undefined, `count=${co.count}`);

// limit — cap descriptors; when more matched, total + truncated flag it.
const lim = await T('reticle_query', { by: 'role', value: 'button', limit: 1 });
const moreThanOne = (co.count ?? 0) > 1;
chk('reticle_query limit caps descriptors (truncated when more)', (lim.elements?.length ?? 0) <= 1 && (!moreThanOne || (lim.truncated === true && lim.total === co.count)), `returned=${lim.elements?.length}, total=${lim.total ?? 'n/a'}`);

// Auth (pre-filled) → dashboard with its count-up animations.
await T('reticle_act_and_wait', { ref: await refOf('testid', 'login-submit'), action: 'click', until: { kind: 'signal', name: 'auth:granted' }, timeout_ms: 5000 });
chk('login → dashboard', (await refOf('testid', 'nav-deployments')) !== null);

// settled wait — the dashboard's count-up counters emit dom.text every frame; settle must STILL
// resolve (the ambient-animation fix). Pre-fix this would time out at 4s with pass:false.
const settled = await T('reticle_wait_for', { predicate: { kind: 'settled', quietMs: 300 }, timeout_ms: 4000 });
chk('settled resolves despite count-up animation churn', settled.pass === true, JSON.stringify(settled.evidence ?? {}));

// act_and_wait with NO `until` → auto-settle after a nav click; verdict carries settled evidence.
const aw = await T('reticle_act_and_wait', { ref: await refOf('testid', 'nav-deployments'), action: 'click' });
chk('act_and_wait (no until) auto-settles', aw.verdict?.pass === true && aw.verdict?.evidence?.settled === true, JSON.stringify(aw.verdict?.evidence ?? {}));

// presence-only advice — a PASSING element assertion is nudged toward a consequence.
const adv = await T('reticle_assert', { predicate: { kind: 'element', query: { testid: 'deploy-list' } } });
chk('reticle_assert presence-only attaches advice', adv.pass === true && typeof adv.advice === 'string' && adv.advice.includes('consequence'), adv.advice ? 'advice present' : 'no advice');

console.log(`\n${fail === 0 ? '✅ NEW FEATURES VERIFIED' : '❌ FAILED'} (${pass} passed, ${fail} failed)`);
await b.close();
await server.close();
process.exit(fail === 0 ? 0 : 1);
