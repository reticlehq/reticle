// A saved flow whose consequence legitimately takes longer than replay's default wait.
//
// Replay's wait for a declared consequence was a fixed 4s with no env var, no flow field and no
// parameter to raise it. That is not a tuning knob — it decides whether an honest flow can ever be
// green. Field reports keep arriving in the same shape: a login whose POST takes several seconds
// against a remote database, and a model-backed import taking tens of seconds. Both were verified
// live with
// `act_and_wait { timeout_ms }` and returned `verified: "yes"`; the identical saved flow drifted at
// ~4020ms with `signal_not_observed`, and the summary said NO LONGER TRUE — a working feature
// reported to the user as a regression. The only ways to green them were to weaken or delete the
// assertion, which the rules correctly forbid, so the flow stayed honest and permanently red.
//
// `FlowStep.timeoutMs` and `FlowFile.signalTimeoutMs` fixed that, against unit tests. This is the
// end-to-end half, and it is a genuine RED/GREEN: the SAME flow against the SAME slow endpoint
// drifts without the declaration and passes with it. If the field ever stops being threaded through,
// the first of these two goes green and the pair stops meaning anything — which is why both
// polarities are asserted rather than only the one we want.
import { chromium } from 'playwright';
import os from 'node:os';
import path from 'node:path';
import {
  start,
  TOOLS,
  BaselineStore,
  RecordingStore,
  FlowStore,
  ProjectStore,
  AnnotationStore,
  createNodeFileSystem,
  replayFlow,
  waitForPredicate,
} from '@reticlehq/server';
import { waitForSession } from '../wait-for-session.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0,
  fail = 0;
const chk = (l, o, d = '') => {
  console.log(`   ${o ? '✅' : '❌'} ${l}${d ? '  — ' + d : ''}`);
  o ? pass++ : fail++;
};

/**
 * Comfortably past the 4000ms default and comfortably short of a slow battery.
 *
 * The field cases were 5.5s and 22s; the boundary that matters is the default, not their exact
 * numbers, so this reproduces the failure with the smallest wall-clock cost that still clears it.
 */
const SERVER_DELAY_MS = 6000;
const GENEROUS_MS = 20000;

const reticleRoot = path.join(os.tmpdir(), `reticle-slow-endpoint-${process.pid}`, '.reticle');
const fsp = createNodeFileSystem();
const now = () => Date.now();
const flows = new FlowStore(fsp, reticleRoot, { now });
const project = new ProjectStore(fsp, reticleRoot, { now });
const server = await start({ port: 4400, mcp: false });
const deps = {
  sessions: server.bridge.sessions,
  baselines: new BaselineStore(),
  recordings: new RecordingStore(),
  flows,
  project,
  fs: fsp,
  reticleRoot,
  now,
  annotations: new AnnotationStore(),
};
// The bench-app self-assigns a per-tab id, so it is identified by the URL it is serving from —
// matching on a fixed name would wait forever for an id that is never used.
const APP_URL = 'http://localhost:4310/';
const isBench = (s) => String(s?.url ?? '').startsWith(APP_URL);
const sessionId = () => server.bridge.sessions.list().find(isBench)?.sessionId;
const T = (n, a = {}) =>
  TOOLS.find((t) => t.name === n).handler(deps, { sessionId: sessionId(), ...a });

const b = await chromium.launch({ headless: true });
const p = await b.newPage();
// `serverDelay` makes the POST itself slow — a different fixture from a fast response rendered late.
await p.goto(`http://localhost:4310/?view=saved-items&serverDelay=${String(SERVER_DELAY_MS)}`);
await waitForSession(() => server.bridge.sessions.list(), isBench, {
  what: 'the bench-app session for the slow-endpoint fixture',
});

console.log('\n=== SLOW ENDPOINT: a flow whose consequence outlives the default wait ===');

const refOf = async (by, value) => {
  for (let i = 0; i < 40; i++) {
    const r = (await T('reticle_query', { by, value })).elements?.[0]?.ref;
    if (r) return r;
    await sleep(150);
  }
  return undefined;
};

// The bench-app shows Login before anything else, and Saved Items is reached from the nav — the
// same path `response-ignored-test.mjs` takes. A query parameter does not select the view.
const loginBtn = await refOf('testid', 'login-submit');
if (loginBtn !== undefined) {
  await T('reticle_act_and_wait', {
    ref: loginBtn,
    action: 'click',
    until: { kind: 'signal', name: 'auth:granted' },
    timeout_ms: 5000,
  });
}
const navRef = await refOf('testid', 'nav-saved-items');
if (navRef !== undefined) {
  await T('reticle_act_and_wait', {
    ref: navRef,
    action: 'click',
    until: { kind: 'signal', name: 'nav:changed' },
    timeout_ms: 5000,
  });
}

const input = await refOf('testid', 'saved-item-input');
const save = await refOf('testid', 'saved-item-submit');
if (input === undefined || save === undefined) {
  chk('the saved-items fixture is reachable', false, `input=${String(input)} save=${String(save)}`);
} else {
  await T('reticle_act', { ref: input, action: 'fill', args: { value: 'slow one' } });

  // The declared consequence: the POST this click causes, which the server holds for SERVER_DELAY_MS.
  const expectNet = { net: { urlContains: '/api/saved-items', method: 'POST', status: 200 } };
  const flowOf = (step) => ({
    version: 1,
    name: 'slow-save',
    createdAt: 0,
    steps: [step],
  });
  const stepBase = {
    tool: 'reticle_act',
    anchor: { kind: 'testid', value: 'saved-item-submit' },
    action: 'click',
    args: {},
    expect: expectNet,
  };

  {
    const live = server.bridge.sessions.resolve(sessionId());

    // RED: the default wait, which is what every flow had before the fix.
    const fast = await replayFlow(live, flowOf({ ...stepBase }), waitForPredicate, 4000);
    chk(
      'without a declared timeout the slow consequence DRIFTS — the reported failure',
      fast[0]?.ok === false,
      `ok=${String(fast[0]?.ok)} drift=${JSON.stringify(fast[0]?.drift ?? {}).slice(0, 90)}`,
    );

    await T('reticle_act', { ref: input, action: 'fill', args: { value: 'slow two' } });

    // GREEN: the same flow, same endpoint, with the step declaring how long it takes.
    const declared = await replayFlow(
      live,
      flowOf({ ...stepBase, timeoutMs: GENEROUS_MS }),
      waitForPredicate,
      4000,
    );
    chk(
      'declaring the step timeout makes the SAME flow against the SAME endpoint pass',
      declared[0]?.ok === true && declared[0]?.drift === undefined,
      `ok=${String(declared[0]?.ok)} drift=${JSON.stringify(declared[0]?.drift ?? {}).slice(0, 90)}`,
    );
  }
}

await b.close();
console.log(`\n${fail === 0 ? '✅ SLOW ENDPOINT VERIFIED' : '❌ FAILED'} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
