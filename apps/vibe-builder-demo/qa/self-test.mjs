/**
 * The SELF-TEST — Reticle testing the app that uses Reticle. A recursive loop:
 *
 *   OUTER Reticle (this harness, bridge :4433) drives the Builder builder UI in a headless browser:
 *     click Generate → select a bug → click "Run QA agent"
 *   …which triggers the INNER Reticle (the /api/verify middleware, bridge :4422) to launch ITS OWN
 *   headless sandbox and verify the preview.
 *   The OUTER Reticle then reads the Builder UI's `builder` store (program truth on the outer layer) to
 *   assert the verdict the inner layer produced actually surfaced in the UI.
 *
 * Two independent Reticle stacks, two headless browsers, two bridges — running at once. If this passes,
 * Reticle has verified an Reticle-powered builder end to end.
 *
 *   PREVIEW_URL=http://localhost:4318 BUG=mock-data node qa/self-test.mjs
 */
import {
  start,
  TOOLS,
  BaselineStore,
  RecordingStore,
  FlowStore,
  AnnotationStore,
  ProjectStore,
  createNodeFileSystem,
  LaunchedRealInputProvider,
} from '@reticle/server';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PREVIEW_BASE = process.env.PREVIEW_URL ?? 'http://localhost:4318';
const OUTER_BRIDGE = Number(process.env.OUTER_BRIDGE ?? 4433);
const BUG = process.env.BUG ?? 'mock-data';
const ENGINE = process.env.ENGINE === 'live' ? 'live' : 'scripted'; // which QA engine the UI runs

/** Deep-find the `builder` store's lastVerdict in whatever reticle_state returns. */
function findBuilder(state) {
  const seen = new Set();
  const walk = (v) => {
    if (v === null || typeof v !== 'object' || seen.has(v)) return undefined;
    seen.add(v);
    if ('lastVerdict' in v && 'phase' in v) return v;
    for (const k of Object.keys(v)) {
      const r = walk(v[k]);
      if (r !== undefined) return r;
    }
    return undefined;
  };
  return walk(state);
}

let pass = 0;
let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`   ${ok ? '✅' : '❌'} ${label}${detail ? ' — ' + detail : ''}`);
  ok ? pass++ : fail++;
};

const server = await start({ port: OUTER_BRIDGE, mcp: false });
const provider = new LaunchedRealInputProvider({
  driveUrl: `${PREVIEW_BASE}/builder.html?reticle=1&bridge=${OUTER_BRIDGE}`,
  headless: true,
});
await provider.navigate();

const fs = createNodeFileSystem();
const reticleRoot = mkdtempSync(join(tmpdir(), 'reticle-selftest-'));
const now = () => Date.now();
const deps = {
  sessions: server.bridge.sessions,
  baselines: new BaselineStore(),
  recordings: new RecordingStore(),
  annotations: new AnnotationStore(),
  flows: new FlowStore(fs, reticleRoot, { now }),
  project: new ProjectStore(fs, reticleRoot, { now }),
  fs,
  reticleRoot,
  now,
  realInput: provider,
};
const T = (name, args = {}) => TOOLS.find((t) => t.name === name).handler(deps, { sessionId: 'builder-ui', ...args });
const refOf = async (testid) => (await T('reticle_query', { by: 'testid', value: testid })).elements?.[0]?.ref;

console.log(`\n=== SELF-TEST: outer Reticle drives the Builder UI; Builder's QA (${ENGINE}) fires the inner Reticle (BUG=${BUG}) ===\n`);

try {
  for (let i = 0; i < 100 && server.bridge.sessions.count() === 0; i++) await sleep(50);
  check('outer Reticle connected to the Builder UI (the builder is itself instrumented)', server.bridge.sessions.count() > 0, `sessions=${server.bridge.sessions.count()}`);
  await T('reticle_wait_ready', { timeoutMs: 10000 });

  // 1. Generate the app
  const gen = await refOf('generate');
  await T('reticle_act_and_wait', { ref: gen, action: 'click' });
  await sleep(900);
  const afterGen = findBuilder(await T('reticle_state', { store: 'builder' }));
  check('clicking Generate booted the preview', afterGen?.generated === true, `phase=${afterGen?.phase}`);

  // 2. Choose the (buggy) generated build
  const bugRef = await refOf('bug');
  await T('reticle_act', { ref: bugRef, action: 'select', args: { value: BUG } });
  await sleep(300);

  // 2b. Pick the QA engine (scripted | live) the builder will run
  const engineRef = await refOf('engine');
  await T('reticle_act', { ref: engineRef, action: 'select', args: { value: ENGINE } });
  await sleep(200);

  // 3. Run the QA agent → this fires the INNER Reticle against the preview
  const verifyRef = await refOf('verify');
  await T('reticle_act', { ref: verifyRef, action: 'click' });

  // 4. Wait for the inner verdict to surface in the Builder store (program truth on the outer layer)
  let verdict = null;
  for (let i = 0; i < 45; i++) {
    const builder = findBuilder(await T('reticle_state', { store: 'builder' }));
    if (builder?.lastVerdict !== null && builder?.lastVerdict !== undefined) {
      verdict = builder.lastVerdict;
      break;
    }
    await sleep(1000);
  }
  check('inner Reticle produced a verdict that surfaced in the Builder UI', verdict !== null, verdict ? `engine=${verdict.engine}` : 'timed out');

  if (verdict !== null) {
    check('blind gate green-lit the build (the pre-Reticle floor)', verdict.blind === 'pass', `blind=${verdict.blind}`);
    if (BUG === 'none') {
      check('inner Reticle PASSED the clean build (no false positive)', verdict.status === 'pass' && verdict.blocked === false, `status=${verdict.status}`);
    } else {
      check('inner Reticle BLOCKED the buggy build (caught what blind missed)', verdict.status === 'fail' && verdict.blocked === true, `status=${verdict.status}`);
    }
  }

  console.log(`\n${fail === 0 ? '✅ SELF-TEST PASSED' : '❌ SELF-TEST FAILED'} — the loop held: Reticle verified an Reticle-powered builder (${pass} passed, ${fail} failed)\n`);
} finally {
  await provider.dispose();
  await server.close();
}
process.exit(fail === 0 ? 0 : 1);
