// Real-world Reticle coverage against the showcase dashboard (apps/demo on :4310 + apps/api on :8787).
// Exercises the full loop on a believable product UI: capability discovery → auth → live store
// state → routing → virtualized scroll-to-find → autonomous crawl. Plain synthetic input (no CDP),
// so it runs in the same lightweight battery as the other specs.
import { chromium } from 'playwright';
import {
  start, TOOLS, BaselineStore, RecordingStore, FlowStore, ProjectStore, AnnotationStore, createNodeFileSystem,
} from '@reticlehq/server';
import os from 'node:os';
import path from 'node:path';
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
await p.goto('http://localhost:4310/?session=demo', { waitUntil: 'networkidle' });
for (let i = 0; i < 200 && server.bridge.sessions.count() === 0; i++) await sleep(50);

console.log('\n=== Reticle × showcase dashboard (:4310) ===');
chk('dashboard SDK connected', server.bridge.sessions.count() > 0);

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
const before = (await T('reticle_query', { by: 'testid', value: 'row-3700' })).elements?.length ?? 0;
const found = await T('reticle_scroll_to', { by: 'testid', value: 'row-3700', container: list, maxScrolls: 60 });
chk('reticle_scroll_to reveals a virtualized row', before === 0 && found.found === true, `scrolls=${found.scrolls}`);

// Autonomous crawl over the diagnostics controls.
await T('reticle_act_and_wait', { ref: await refOf('testid', 'nav-diagnostics'), action: 'click', until: { kind: 'signal', name: 'nav:changed' }, timeout_ms: 3000 });
await sleep(300);
const crawl = await T('reticle_crawl', { maxSteps: 8, settleMs: 220 });
chk('reticle_crawl drives the controls + reports', crawl.stepsRun > 0, `clicked=${crawl.stepsRun}, anomalies=${crawl.anomalies.length}`);

console.log(`\n${fail === 0 ? '✅ REAL-WORLD VERIFIED' : '❌ FAILED'} (${pass} passed, ${fail} failed)`);
await b.close();
await server.close();
process.exit(fail === 0 ? 0 : 1);
