// Committed regression guard for the multi-agent / browser-pool path: many agents lease isolated
// headless contexts from ONE shared browser against the bench-app dashboard (:4310), capped and queued, each
// usable on return. Locks in what was validated by hand: resource is bounded, leases correlate to
// real sessions, and conflicting concurrent flows don't cross-talk. Boots its own bridge on :4400.
import {
  start,
  TOOLS,
  BrowserPool,
  NodeStorageProfileStore,
  playwrightLauncher,
  appendReticleParams,
  BaselineStore,
  RecordingStore,
  FlowStore,
  ProjectStore,
  AnnotationStore,
  createNodeFileSystem,
} from '@reticlehq/server';
import os from 'node:os';
import path from 'node:path';
import { rm } from 'node:fs/promises';

const APP = 'http://localhost:4310/';
let pass = 0,
  fail = 0;
const chk = (label, ok, detail = '') => {
  console.log(`   ${ok ? '✅' : '❌'} ${label}${detail ? '  — ' + detail : ''}`);
  ok ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitUntil = async (fn, ms = 12000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(40);
  }
  return false;
};

const server = await start({ port: 4400, mcp: false });
const reticleRoot = path.join(os.tmpdir(), `reticle-malease-${process.pid}`, '.reticle');
const fs = createNodeFileSystem();
const now = () => Date.now();
const deps = {
  sessions: server.bridge.sessions,
  baselines: new BaselineStore(),
  recordings: new RecordingStore(),
  flows: new FlowStore(fs, reticleRoot, { now }),
  project: new ProjectStore(fs, reticleRoot, { now }),
  annotations: new AnnotationStore(),
  fs,
  reticleRoot,
  now,
};
const T = (n, a) => TOOLS.find((t) => t.name === n).handler(deps, a);

let launches = 0;
const pool = new BrowserPool(
  () => {
    launches += 1;
    return playwrightLauncher({ headless: true })();
  },
  {
    maxContexts: 3,
    genSessionId: () => `g${process.pid}-${launches}`,
    storageProfiles: new NodeStorageProfileStore(path.join(reticleRoot, 'storage-profiles')),
  },
);

console.log('\n=== multi-agent leases against the live bench-app (cap 3) ===');

// 6 "agents" lease + drive + release concurrently. Cap 3 ⇒ peak ≤ 3, the rest queue and cascade.
let peak = 0;
const sampler = setInterval(() => {
  peak = Math.max(peak, pool.activeCount());
}, 10);
const seen = new Set();
const results = await Promise.allSettled(
  Array.from({ length: 6 }, (_, i) =>
    (async () => {
      const sid = `agent-${process.pid}-${i}`;
      const navUrl = appendReticleParams(APP, sid); // the app's SDK adopts __reticle_session
      const lease = await pool.acquire(navUrl, { sessionId: sid });
      // Generous on purpose. Six leases share ONE browser behind a cap of 3, so half of them wait
      // for a slot before their page even loads — and this spec asserts that all six eventually
      // lease and drive, never that any of them does so within N seconds. A tight bound here is an
      // assertion about the machine: it passed alone and failed under parallel load, which is to say
      // it failed only in CI.
      const connected = await waitUntil(() => server.bridge.sessions.get(sid) !== undefined, 60000);
      if (!connected) {
        await lease.release();
        throw new Error(`${sid} never connected`);
      }
      seen.add(sid);
      // Conflicting flow: each agent queries the live dashboard and reads its own session's state.
      const q = await T('reticle_query', { sessionId: sid, by: 'role', value: 'button' });
      const buttons = q.elements?.length ?? 0;
      await sleep(30);
      await lease.release();
      return { sid, buttons };
    })(),
  ),
);
clearInterval(sampler);

const ok = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
// Print WHY an agent failed. `0/6` on its own says nothing: the same number covers a dead app, a
// pool at capacity, and a lease that never connected. One line here turned an opaque failure into
// `ERR_CONNECTION_REFUSED` — a spec run without its bench-app — in a single read.
for (const r of results) {
  if ('rejected' === r.status) console.log('   rejected:', String(r.reason).slice(0, 200));
}
chk('all 6 agents leased + drove + released', ok.length === 6, `${ok.length}/6`);
chk('resource bounded: peak contexts never exceeded the cap of 3', peak > 0 && peak <= 3, `peak=${peak}`);
chk('ONE shared browser served the whole fleet', launches === 1, `launches=${launches}`);
chk('each leased tab connected as its own session (distinct)', new Set(ok.map((r) => r.sid)).size === ok.length);
chk('each agent drove the live dashboard (found buttons)', ok.length > 0 && ok.every((r) => r.buttons > 0), `buttons=${ok.map((r) => r.buttons).join('/')}`);
chk('no leaked contexts after all agents done', pool.activeCount() === 0);

console.log('\n=== project-scoped persistent browser storage ===');

const refOf = async (sessionId, testid) => {
  const q = await T('reticle_query', { sessionId, by: 'testid', value: testid });
  return q.elements?.[0]?.ref;
};
const acquireProject = async (projectId) => {
  const sid = `storage-${projectId}-${process.pid}-${Date.now()}`;
  const lease = await pool.acquire(appendReticleParams(APP, sid, projectId), {
    sessionId: sid,
    persistStorage: { projectId },
  });
  const connected = await waitUntil(() => server.bridge.sessions.get(sid) !== undefined, 30000);
  if (!connected) {
    await lease.release();
    throw new Error(`${sid} never connected`);
  }
  return { sid, lease };
};
const hasPersistedAuth = async (sessionId) => {
  const local = await T('reticle_storage', {
    sessionId,
    area: 'local',
    key: 'reticle.bench.authToken',
  });
  const cookie = await T('reticle_storage', {
    sessionId,
    area: 'cookies',
    key: 'bench_session',
  });
  return local.found === true && cookie.found === true;
};

const firstA = await acquireProject('project-a');
const loginRef = await refOf(firstA.sid, 'login-submit');
if (loginRef === undefined) throw new Error('project-a clean context did not show login');
await T('reticle_act_and_wait', {
  sessionId: firstA.sid,
  ref: loginRef,
  action: 'click',
  until: { kind: 'signal', name: 'auth:granted' },
  timeout_ms: 5000,
});
const firstRelease = await pool.release(firstA.sid);
chk('release captured project A cookies and local storage', firstRelease.storageSaved === true);

const restoredA = await acquireProject('project-a');
chk('same project reports that its profile was restored', restoredA.lease.storageRestored === true);
chk('same project restores its auth token and cookie', await hasPersistedAuth(restoredA.sid));
await restoredA.lease.release();

const cleanB = await acquireProject('project-b');
chk('different project cannot see project A auth', !(await hasPersistedAuth(cleanB.sid)));
await cleanB.lease.release();

chk('explicit reset removes project A profile', await pool.resetStorageProfile('project-a'));
const resetA = await acquireProject('project-a');
chk('reset project has no auth token or cookie', !(await hasPersistedAuth(resetA.sid)));
await resetA.lease.release();

await pool.shutdown();
await server.close();
await rm(path.dirname(reticleRoot), { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✅' : '❌'} MULTI-AGENT LEASE: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
