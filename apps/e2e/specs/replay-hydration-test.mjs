import { TEST_BRIDGE_PORT } from '../gate-harness.mjs';
// Flow replay and React hydration, in real Chromium against real Next and Vite dev servers (#1654).
//
// The defect: a Next page connects Reticle after its shell hydrates, while a Suspense boundary under
// the shell still waits for hydration. Its server-rendered button is on the page, so a query finds
// it, but React has not attached its handler. Replay clicked it at once, nothing happened, and step 1
// failed with "expect.element testid "revealed" not present after the action" on a correct app.
//
// Only a real React hydration in a real browser can show this. The unit tests drive React in jsdom
// and call the commit hook by hand; they cannot show when Next loads React, when the adapter
// installs, or that React's commits reach the adapter's hook.
//
// Four cases, all on the same flow shape (click a button, expect what it reveals):
//   1. Hydration ends inside the bound: the step passes, and no `hydrationWait` is reported.
//      Fails on a replay that does not wait for hydration, for the reason the issue reports.
//   2. Hydration ends after the bound: the replay is `unverifiable`, and the reason names hydration
//      first and the step's own failure after it. `reticle_verify` keeps `hydrationWaits`.
//   3. A page with the React adapter and no React tree: replay does not wait at all.
//   4. A server-rendered page that hydrates at once: replay does not wait at all.
import { chromium } from 'playwright';
import os from 'node:os';
import path from 'node:path';
import nfs from 'node:fs';
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
import { waitForSession } from '../wait-for-session.mjs';

// The battery serves next-smoke on :3100 and bench-app on :4310. A run by hand can point elsewhere.
const NEXT_ORIGIN = process.env.RETICLE_E2E_NEXT_ORIGIN ?? 'http://localhost:3100';
const BENCH_ORIGIN = process.env.RETICLE_E2E_BENCH_ORIGIN ?? 'http://localhost:4310';
/** Well inside replay's hydration bound, and long after the SDK connects. */
const INSIDE_MS = 4000;
/** Far past the bound, so the boundary is still dehydrated when replay gives up. */
const PAST_MS = 120000;

let pass = 0;
let fail = 0;
const chk = (label, ok, detail = '') => {
  console.log(`   ${ok ? '✅' : '❌'} ${label}${detail ? `  — ${detail}` : ''}`);
  ok ? (pass += 1) : (fail += 1);
};

const reticleRoot = path.join(os.tmpdir(), `reticle-replay-hydration-${process.pid}`, '.reticle');
const fsp = createNodeFileSystem();
const now = () => Date.now();
const flows = new FlowStore(fsp, reticleRoot, { now });
const server = await start({ port: TEST_BRIDGE_PORT, mcp: false });
const deps = {
  sessions: server.bridge.sessions,
  baselines: new BaselineStore(),
  recordings: new RecordingStore(),
  flows,
  project: new ProjectStore(fsp, reticleRoot, { now }),
  fs: fsp,
  reticleRoot,
  now,
  annotations: new AnnotationStore(),
};
const T = (name, args) => TOOLS.find((t) => t.name === name).handler(deps, args);

/** One click whose consequence only a working handler can produce. */
function revealFlow(name, startPath, button, revealed) {
  return {
    version: 1,
    name,
    createdAt: now(),
    startPath,
    labels: [name],
    steps: [
      {
        tool: 'reticle_act',
        anchor: { kind: 'testid', value: button },
        action: 'click',
        args: {},
        expect: { element: { testid: revealed } },
      },
    ],
  };
}

const browser = await chromium.launch({ headless: true });

/** Open the start page as a person would, and wait for its session to connect. */
async function open(origin, startPath, sessionId) {
  const page = await browser.newPage();
  await page.goto(`${origin}${startPath}`);
  await waitForSession(() => server.bridge.sessions.list(), sessionId);
  return page;
}

const stepText = (result) => JSON.stringify(result.steps?.[0] ?? {}).slice(0, 200);

try {
  console.log('\n=== flow replay waits for React hydration (real Chromium, Next + Vite) ===');

  // 1. Hydration ends inside the bound. Through `reticle_verify`, the path the issue names.
  const inside = revealFlow(
    'hydrate-inside',
    `/hydrate?delay=${String(INSIDE_MS)}&session=hydrate-inside`,
    'reveal',
    'revealed',
  );
  await flows.saveFlow(inside);
  const insidePage = await open(NEXT_ORIGIN, inside.startPath, 'hydrate-inside');
  const suite = await T('reticle_verify', {
    action: 'flows',
    labels: [inside.name],
    sessionId: 'hydrate-inside',
  });
  chk(
    'a click on a button that hydrates inside the bound passes (reticle_verify)',
    'pass' === suite.status,
    `${String(suite.status)}: ${String(suite.summary)} ${JSON.stringify(suite.failures ?? []).slice(0, 200)}`,
  );
  chk(
    'the suite reports no hydration wait when the page hydrated inside the bound',
    suite.hydrationWaits === undefined,
    JSON.stringify(suite.hydrationWaits ?? null),
  );
  await insidePage.close();

  // 2. Hydration ends after the bound.
  const past = revealFlow(
    'hydrate-past',
    `/hydrate?delay=${String(PAST_MS)}&session=hydrate-past`,
    'reveal',
    'revealed',
  );
  await flows.saveFlow(past);
  const pastPage = await open(NEXT_ORIGIN, past.startPath, 'hydrate-past');
  const late = await T('reticle_flow_replay', { flowName: past.name, sessionId: 'hydrate-past' });
  const reason = String(late.unverifiable?.reason ?? '');
  chk(
    'a page that does not hydrate inside the bound makes the replay unverifiable, not a failure',
    'unverifiable' === late.status,
    `${String(late.status)}: ${stepText(late)}`,
  );
  chk(
    'the reason names hydration first, and the step failure after it',
    /hydrat/i.test(reason.slice(0, 120)) && reason.includes('revealed'),
    reason.slice(0, 300),
  );
  chk(
    'the replay carries hydrationWait with the bound it reached',
    'number' === typeof late.hydrationWait?.budgetMs &&
      late.hydrationWait.waitedMs >= late.hydrationWait.budgetMs,
    JSON.stringify(late.hydrationWait ?? null),
  );
  const pastSuite = await T('reticle_verify', {
    action: 'flows',
    labels: [past.name],
    sessionId: 'hydrate-past',
  });
  chk(
    'reticle_verify keeps the hydration wait on the suite verdict',
    Array.isArray(pastSuite.hydrationWaits) &&
      pastSuite.hydrationWaits.some((row) => row.flow === past.name),
    JSON.stringify(pastSuite.hydrationWaits ?? null),
  );
  chk(
    'reticle_verify counts the flow as unverifiable, not failed',
    'unverifiable' === pastSuite.status && 0 === pastSuite.failed,
    `${String(pastSuite.status)}: ${String(pastSuite.summary)}`,
  );
  await pastPage.close();

  // 2b. A `navigate` step opens a page that hydrates late. The next step must wait for it too.
  const slowUrl = `/hydrate?delay=${String(INSIDE_MS)}&session=hydrate-nav`;
  // From another path: a navigate to the same path with another query is read as already there.
  const nav = revealFlow('hydrate-nav', '/?session=hydrate-nav', 'reveal', 'revealed');
  nav.steps.unshift({
    tool: 'reticle_navigate',
    anchor: { kind: 'testid', value: slowUrl },
    navigate: slowUrl,
  });
  await flows.saveFlow(nav);
  const navPage = await open(NEXT_ORIGIN, nav.startPath, 'hydrate-nav');
  const opened = await T('reticle_flow_replay', { flowName: nav.name, sessionId: 'hydrate-nav' });
  chk(
    'a click on the page that a navigate step opened waits for it to hydrate',
    'ok' === opened.status && opened.hydrationWait === undefined,
    `${String(opened.status)}: ${JSON.stringify(opened.steps?.[1] ?? opened.unverifiable ?? {}).slice(0, 200)}`,
  );
  await navPage.close();

  // 3. The React adapter on a page with no React tree.
  const plain = revealFlow(
    'static-page',
    '/static.html?session=static-page',
    'static-reveal',
    'static-revealed',
  );
  await flows.saveFlow(plain);
  const plainPage = await open(BENCH_ORIGIN, plain.startPath, 'static-page');
  const flatStarted = now();
  const flat = await T('reticle_flow_replay', { flowName: plain.name, sessionId: 'static-page' });
  const flatMs = now() - flatStarted;
  chk(
    'a page with the adapter and no React tree replays green',
    'ok' === flat.status,
    `${String(flat.status)}: ${stepText(flat)}`,
  );
  chk(
    'and replay does not wait for a hydration that cannot come',
    flat.hydrationWait === undefined,
    `${JSON.stringify(flat.hydrationWait ?? null)}, replay took ${String(flatMs)} ms`,
  );
  await plainPage.close();

  // 4. A server-rendered page with nothing held: no wait either.
  const quick = revealFlow('hydrate-quick', '/hydrate?session=hydrate-quick', 'reveal', 'revealed');
  await flows.saveFlow(quick);
  const quickPage = await open(NEXT_ORIGIN, quick.startPath, 'hydrate-quick');
  const fast = await T('reticle_flow_replay', { flowName: quick.name, sessionId: 'hydrate-quick' });
  chk(
    'a page that hydrated at once replays green with no hydration wait',
    'ok' === fast.status && fast.hydrationWait === undefined,
    `${String(fast.status)}: ${JSON.stringify(fast.hydrationWait ?? null)} ${stepText(fast)}`,
  );
  await quickPage.close();
} catch (error) {
  chk('the spec ran to the end', false, String(error?.stack ?? error));
} finally {
  await browser.close();
  await server.close();
  nfs.rmSync(path.dirname(reticleRoot), { recursive: true, force: true });
}

console.log(
  `\n${fail === 0 ? '✅ REPLAY WAITS FOR HYDRATION' : `❌ ${String(fail)} FAILED`} (${String(pass)} passed, ${String(fail)} failed)`,
);
process.exit(fail === 0 ? 0 : 1);
