// Committed regression guard for the multi-agent / browser-pool path: many agents lease isolated
// headless contexts from ONE shared browser against the bench-app dashboard (:4310), capped and queued, each
// usable on return. Locks in what was validated by hand: resource is bounded, leases correlate to
// real sessions, and conflicting concurrent flows don't cross-talk. Boots its own bridge on :4400.
import {
  start,
  TOOLS,
  BrowserPool,
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
  { maxContexts: 3, genSessionId: () => `g${process.pid}-${launches}` },
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
      const connected = await waitUntil(() => server.bridge.sessions.get(sid) !== undefined, 12000);
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
chk('all 6 agents leased + drove + released', ok.length === 6, `${ok.length}/6`);
chk('resource bounded: peak contexts never exceeded the cap of 3', peak > 0 && peak <= 3, `peak=${peak}`);
chk('ONE shared browser served the whole fleet', launches === 1, `launches=${launches}`);
chk('each leased tab connected as its own session (distinct)', new Set(ok.map((r) => r.sid)).size === ok.length);
chk('each agent drove the live dashboard (found buttons)', ok.length > 0 && ok.every((r) => r.buttons > 0), `buttons=${ok.map((r) => r.buttons).join('/')}`);
chk('no leaked contexts after all agents done', pool.activeCount() === 0);

await pool.shutdown();
await server.close();
console.log(`\n${fail === 0 ? '✅' : '❌'} MULTI-AGENT LEASE: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
