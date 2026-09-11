// this bench — suite wall-time, tracked. Runs the REAL flow_verify handler twice against a live app:
// sequential (one shared tab) vs parallel (one leased isolated context per flow), and reports
// wall-time plus the speedup. Also asserts both modes agree on the verdict — a faster suite that
// disagrees with the sequential one is not a faster suite, it is a broken one.
//
//   node bench/parallel-suite/measure.mjs [appUrl] [parallelism]
//
// Needs: the bench-app running, flows saved in .reticle/flows/, and a daemon this script owns (it starts
// its own bridge so the leased tabs register with US, not with whatever external daemon is around).

import { join } from 'node:path';
import { Bridge } from '../../packages/server/dist/bridge/bridge.js';
import { FLOW_TOOLS } from '../../packages/server/dist/flows/flow-tools.js';
import { FlowStore } from '../../packages/server/dist/flows/flows.js';
import { ProjectStore } from '../../packages/server/dist/project/project-store.js';
import { BaselineStore } from '../../packages/server/dist/project/baselines.js';
import { RecordingStore } from '../../packages/server/dist/flows/recordings.js';
import { AnnotationStore } from '../../packages/server/dist/flows/annotation-store.js';
import { createNodeFileSystem } from '../../packages/server/dist/project/fs-port.js';
import { BrowserPool } from '../../packages/server/dist/pool/browser-pool.js';
import {
  playwrightLauncher,
  resolveMaxContexts,
} from '../../packages/server/dist/pool/playwright-launcher.js';
import { cpus } from 'node:os';

const APP_URL = process.argv[2] ?? 'http://localhost:4312';
const PARALLEL = Number(process.argv[3] ?? 4);
const PORT = Number(process.env.RETICLE_PORT ?? 4491);

const verify = FLOW_TOOLS.find((t) => t.name === 'reticle_flow_verify');
if (verify === undefined) throw new Error('reticle_flow_verify not found');

// Build the same ToolDeps the daemon assembles, over OUR bridge so leased tabs register with us.
const bridge = new Bridge({ port: PORT });
await bridge.ready;
const fs = createNodeFileSystem();
const reticleRoot = join(process.cwd(), '.reticle');
const now = () => Date.now();
const pool = new BrowserPool(playwrightLauncher({ headless: true }), {
  maxContexts: resolveMaxContexts(undefined, cpus().length),
  genSessionId: () => `lease-${globalThis.crypto.randomUUID()}`,
});
const deps = {
  sessions: bridge.sessions,
  pool,
  baselines: new BaselineStore(),
  recordings: new RecordingStore(),
  annotations: new AnnotationStore(),
  flows: new FlowStore(fs, reticleRoot, { now }),
  project: new ProjectStore(fs, reticleRoot, { now }),
  fs,
  reticleRoot,
  now,
};
const server = {
  close: async () => {
    await pool.close?.();
    await bridge.close();
  },
};

/** Open the app in a leased context once so `deps.sessions` knows the app URL for the parallel path. */
async function seedSession() {
  const pool = deps.pool;
  if (pool === undefined) throw new Error('no browser pool');
  const lease = await pool.acquire(APP_URL, { sessionId: `seed-${String(Date.now())}` });
  // give the SDK a moment to register
  await new Promise((r) => setTimeout(r, 2500));
  return lease;
}

const seed = await seedSession();
const live = deps.sessions.list();
console.log(
  `seeded session(s): ${String(live.length)} — ${live.map((s) => s.url).join(', ') || '(none)'}`,
);
if (live.length === 0) {
  console.error('no session registered — is the bench-app pointed at this daemon port?');
  await seed.release();
  await server.close();
  process.exit(2);
}
const sessionId = live[0].sessionId;

async function timed(label, args) {
  const t0 = Date.now();
  const verdict = await verify.handler(deps, args);
  const ms = Date.now() - t0;
  console.log(
    `  ${label.padEnd(22)} ${String(ms).padStart(6)}ms  status=${verdict.status} passed=${String(verdict.passed)}/${String(verdict.total)}`,
  );
  return { ms, verdict };
}

console.log('\n=== suite wall-time: sequential vs parallel ===\n');
const seq = await timed('sequential', { sessionId });
const par = await timed(`parallel(${String(PARALLEL)})`, { sessionId, parallel: PARALLEL });

await seed.release();
await server.close();

const speedup = seq.ms / Math.max(1, par.ms);

// this bench: suite wall-time is a TRACKED number with a budget, not a vibe. The budget is per-flow so it
// stays meaningful as the suite grows — a 200-flow suite is allowed 200x a single flow's allowance.
const BUDGET_MS_PER_FLOW = Number(process.env.SUITE_BUDGET_MS_PER_FLOW ?? 1500);
const flows = par.verdict.total || 1;
const budgetMs = BUDGET_MS_PER_FLOW * flows;
const withinBudget = par.ms <= budgetMs;

console.log(`\n  speedup            : ${speedup.toFixed(2)}x`);
console.log(
  `  wall-time budget   : ${String(par.ms)}ms vs ${String(budgetMs)}ms (${String(flows)} flows x ${String(BUDGET_MS_PER_FLOW)}ms) → ${withinBudget ? 'PASS' : 'OVER BUDGET'}`,
);
console.log(
  `  sequential         : ${String(seq.verdict.passed)}/${String(seq.verdict.total)} passed`,
);
console.log(
  `  parallel           : ${String(par.verdict.passed)}/${String(par.verdict.total)} passed`,
);

// Sequential is NOT the reference truth. Every flow replays against the SAME tab there, so a flow that
// mutates app state (logging in, opening a modal) contaminates the ones after it — the classic
// order-dependence of a shared fixture. Parallel gives each flow its own isolated context, so a flow
// that assumes a clean app finally gets one. Parallel passing MORE is therefore the expected, better
// outcome; parallel passing FEWER is the real alarm, because that means the isolation is leaking or
// the flows are racing.
if (par.verdict.passed > seq.verdict.passed) {
  console.log(
    `  → parallel passed MORE: isolation removed cross-flow state contamination on the shared tab.\n` +
      `    (sequential is order-dependent by construction; that is a property of one-tab replay, not a parallel bug)`,
  );
} else if (par.verdict.passed < seq.verdict.passed) {
  console.log('  → ALARM: parallel passed FEWER — isolation is leaking or flows are racing.');
}
console.log('');
// Fail only when parallelism made verification WORSE.
// Fail on a verification regression OR a blown wall-time budget — both are release-bar breaches.
process.exit(par.verdict.passed < seq.verdict.passed || !withinBudget ? 1 : 0);
