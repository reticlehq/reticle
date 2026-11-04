import { TEST_BRIDGE_PORT } from '../gate-harness.mjs';
// A route claim and an absence claim, in both directions, in a real browser (#2176).
//
// Two rules withheld `yes` from claims that held. `action-had-no-effect` fired beside a passing
// `route` predicate when the window held no events, as after a full navigation. The virtualized
// blind spot made a dialog asserted absent by testid `unknown` when a virtualized list was on the
// page. Both fixes make a rule report less often, so each one has a control that must still hold:
// a click on an inert button is never `yes`, and a row that the list did not render is never
// proved absent.
//
// In this browser a full navigation records the requests that load the new document, so the window
// is not empty and the route pair passes also without the fix. The pair keeps a full navigation
// `yes` and an inert click not `yes`. The engine test `route-claim-is-an-effect.test.ts` holds the
// empty window.
//
// Each direction also reads the session's own events, so a fixture that stops producing its shape
// fails here instead of passing for free.
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
} from '@reticlehq/server';
import { waitForSession } from '../wait-for-session.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0,
  fail = 0;
const chk = (l, o, d = '') => {
  console.log(`   ${o ? '✅' : '❌'} ${l}${d ? '  — ' + d : ''}`);
  o ? pass++ : fail++;
};

const APP_URL = 'http://localhost:4310/';
const ARRIVED = '/claim-pairs/arrived';
const NO_EFFECT = 'action-had-no-effect';
const VERIFIED_YES = 'yes';
const VERIFIED_UNKNOWN = 'unknown';
const ABSENCE_BLIND_SPOT = 'absence_blind_spot';
const DOM_REMOVED = 'dom.removed';
const BLIND_SPOT = 'blind-spot';
const VIRTUALIZED = 'virtualized-unmounted';
const DIALOG = 'claim-pairs-dialog';
/** A row in the middle of the list: in the data, never rendered while the list is at the top. */
const HIDDEN_ROW = 'Invoice #150';

const server = await start({ port: TEST_BRIDGE_PORT, mcp: false });
const reticleRoot = path.join(os.tmpdir(), `reticle-claim-pairs-${process.pid}`, '.reticle');
const fsp = createNodeFileSystem();
const now = () => Date.now();
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
const isBench = (s) => String(s?.url ?? '').startsWith(APP_URL);
const sessionId = () => server.bridge.sessions.list().find(isBench)?.sessionId;
const T = (n, a = {}) =>
  TOOLS.find((t) => t.name === n).handler(deps, { sessionId: sessionId(), ...a });
const events = (since) => server.bridge.sessions.resolve(sessionId()).queryEvents({ since });
const kindsOf = (verdict) => (verdict.contradictions ?? []).map((c) => String(c.kind ?? ''));
const why = (verdict) =>
  `verified=${String(verdict.verified)} reason=${String(verdict.verifiedReason ?? '')} kinds=${JSON.stringify(kindsOf(verdict))}`;

const b = await chromium.launch({ headless: true });
const p = await b.newPage();
// The fixture views are opt-in, so the benchmark page has no link to them (fixture-views.ts).
await p.goto(`${APP_URL}?fixture-views=1`, { waitUntil: 'domcontentloaded' });
await waitForSession(() => server.bridge.sessions.list(), isBench, {
  what: 'the bench-app session for the claim-pairs fixture',
});

const refOf = async (value) => {
  for (let i = 0; i < 40; i++) {
    const r = (await T('reticle_query', { by: 'testid', value })).elements?.[0]?.ref;
    if (r) return r;
    await sleep(150);
  }
  return undefined;
};

/** Click a control and wait for `until`. Undefined when the control cannot be found. */
const act = async (testid, until) => {
  const ref = await refOf(testid);
  if (ref === undefined) {
    chk(`the ${testid} control is reachable`, false);
    return undefined;
  }
  return T('reticle_act_and_wait', { ref, action: 'click', until, timeout_ms: 8000 });
};

const loginBtn = await refOf('login-submit');
if (loginBtn !== undefined) {
  await T('reticle_act_and_wait', {
    ref: loginBtn,
    action: 'click',
    until: { kind: 'signal', name: 'auth:granted' },
    timeout_ms: 5000,
  });
}
await act('nav-claim-pairs', { kind: 'signal', name: 'nav:changed' });
await p.locator('[data-testid="claim-pairs-list"]', { hasText: 'Invoice #0' }).waitFor();

/** The largest count of unmounted virtualized rows the SDK reported, waiting for its first report. */
const unmountedRows = async () => {
  for (let i = 0; i < 40; i++) {
    const counts = (await events(0))
      .filter((e) => BLIND_SPOT === e.type && VIRTUALIZED === e.data?.kind)
      .map((e) => Number(e.data?.count ?? 0));
    if (counts.length > 0) return Math.max(...counts);
    await sleep(150);
  }
  return 0;
};
const unmounted = await unmountedRows();
chk(
  'the SDK reported unmounted rows in the list, otherwise this proves nothing',
  unmounted > 0,
  `count=${String(unmounted)}`,
);

console.log('\n=== absence by testid: a dialog closed beside a virtualized list ===');
const closed = await act('claim-pairs-dialog-close', {
  kind: 'element',
  query: { testid: DIALOG },
  absent: true,
});
if (closed !== undefined) {
  chk('the closed dialog is verified yes', VERIFIED_YES === closed.verified, why(closed));
  const removal = (await events(closed.since)).find(
    (e) => DOM_REMOVED === e.type && DIALOG === e.data?.testid,
  );
  chk(
    'the window holds the dialog leaving the page, otherwise this proves nothing',
    removal !== undefined,
  );
}

console.log('\n=== absence by text: a row the virtualized list did not render ===');
const archived = await act('claim-pairs-archive', {
  kind: 'element',
  query: { text: HIDDEN_ROW },
  absent: true,
});
if (archived !== undefined) {
  chk('the absent row is unknown', VERIFIED_UNKNOWN === archived.verified, why(archived));
  chk(
    'the reason is the blind spot',
    ABSENCE_BLIND_SPOT === archived.verifiedReason,
    why(archived),
  );
  const rows = await p.evaluate(() => document.querySelectorAll('[role="row"]').length);
  chk(
    'the row is in the data and not rendered, otherwise this proves nothing',
    rows > 0 && 0 === (await p.getByText(HIDDEN_ROW, { exact: true }).count()),
    `rendered=${String(rows)}`,
  );
}

console.log('\n=== no route claim: a click on an inert button with a settled wait ===');
const inert = await act('claim-pairs-inert', { kind: 'settled' });
if (inert !== undefined) {
  chk('the inert click is not verified yes', VERIFIED_YES !== inert.verified, why(inert));
  chk('the inert click is reported', kindsOf(inert).includes(NO_EFFECT), why(inert));
}

console.log('\n=== route claim: a click that does a full navigation ===');
const navigated = await act('claim-pairs-navigate', { kind: 'route', pathname: ARRIVED });
if (navigated !== undefined) {
  chk('the navigation is verified yes', VERIFIED_YES === navigated.verified, why(navigated));
  chk('the navigation is not reported as no effect', !kindsOf(navigated).includes(NO_EFFECT), why(navigated));
  chk(
    'the page really loaded the new route, otherwise this proves nothing',
    ARRIVED === new URL(p.url()).pathname,
    p.url(),
  );
}

await b.close();
console.log(
  `\n${fail === 0 ? '✅ ROUTE AND ABSENCE CLAIMS VERIFIED' : '❌ FAILED'} (${pass} passed, ${fail} failed)`,
);
process.exit(fail === 0 ? 0 : 1);
