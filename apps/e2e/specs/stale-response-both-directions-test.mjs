import { TEST_BRIDGE_PORT } from '../gate-harness.mjs';
// `stale-response-applied`, in both directions, in a real browser.
//
// #2087 and #2097 both changed this rule after false `no` verdicts from the field: one click opened
// a page that read one path twice, one read per panel, and the first answer landed last. Only unit
// tests at the `findContradictions` level covered those changes. No gate above them could see the
// rule, so a change could stop it finding a real race, or start it reporting a false one.
//
//   - Fan-out: `reticle_act_and_wait` on one click must not report the rule.
//   - Real race: a check that spans two filter clicks must report the rule.
//
// Each direction also reads the request timeline. If the fixture stops producing the shape, the
// silent direction passes for free and this spec proves nothing.
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
const STALE = 'stale-response-applied';
const ITEMS = '/api/stale-race/items';
/** The rule's own bound: reads closer than this are one task, so they test a different guard. */
const SAME_TASK_MS = 2;

const server = await start({ port: TEST_BRIDGE_PORT, mcp: false });
const reticleRoot = path.join(os.tmpdir(), `reticle-stale-race-${process.pid}`, '.reticle');
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

/** When the read of `type` was issued and when it settled, from the session's own events. */
const flight = async (since, type) => {
  const events = await server.bridge.sessions.resolve(sessionId()).queryEvents({ since });
  const of = (kind) =>
    events.find(
      (e) => e.type === kind && String(e.data?.url ?? '').includes(`${ITEMS}?type=${type}`),
    )?.t;
  return { issued: of('net.pending'), settled: of('net.request') };
};

/** Reads that overlap, and settle out of order, more than one task apart. */
const racedOutOfOrder = (first, second) =>
  second.issued - first.issued >= SAME_TASK_MS &&
  second.issued < first.settled &&
  second.settled < first.settled;

const kindsOf = (verdict) => (verdict.contradictions ?? []).map((c) => String(c.kind ?? ''));

const b = await chromium.launch({ headless: true });
const p = await b.newPage();
await p.goto(APP_URL, { waitUntil: 'domcontentloaded' });
await waitForSession(() => server.bridge.sessions.list(), isBench, {
  what: 'the bench-app session for the stale-race fixture',
});

const refOf = async (by, value) => {
  for (let i = 0; i < 40; i++) {
    const r = (await T('reticle_query', { by, value })).elements?.[0]?.ref;
    if (r) return r;
    await sleep(150);
  }
  return undefined;
};

const loginBtn = await refOf('testid', 'login-submit');
if (loginBtn !== undefined) {
  await T('reticle_act_and_wait', {
    ref: loginBtn,
    action: 'click',
    until: { kind: 'signal', name: 'auth:granted' },
    timeout_ms: 5000,
  });
}
const navRef = await refOf('testid', 'nav-stale-race');
if (navRef !== undefined) {
  await T('reticle_act_and_wait', {
    ref: navRef,
    action: 'click',
    until: { kind: 'signal', name: 'nav:changed' },
    timeout_ms: 5000,
  });
}

console.log('\n=== FAN-OUT: one click that loads two panels is not a race ===');
const open = await refOf('testid', 'stale-race-open-panels');
if (open === undefined) {
  chk('the fan-out fixture is reachable', false, 'no stale-race-open-panels testid');
} else {
  // The net clause holds the window open until the late read settles. The text clause holds it open
  // until the app renders that answer. The order of those two events is not fixed, and the rule needs
  // both of them in the window, or it stays silent for the wrong reason.
  const verdict = await T('reticle_act_and_wait', {
    ref: open,
    action: 'click',
    until: {
      kind: 'allOf',
      predicates: [
        { kind: 'net', urlContains: `${ITEMS}?type=a`, method: 'GET', status: 200 },
        { kind: 'text', contains: 'Panel a ready' },
      ],
    },
    timeout_ms: 10000,
  });
  const kinds = kindsOf(verdict);
  chk(
    'the action was verified as a pass',
    true === verdict.pass || 'yes' === verdict.verified,
    `verified=${String(verdict.verified)} reason=${String(verdict.verifiedReason ?? '')}`,
  );
  chk(
    'one click that reads one path twice is not reported as a stale response',
    !kinds.includes(STALE),
    `kinds=${JSON.stringify(kinds)}`,
  );
  const a = await flight(verdict.since, 'a');
  const c = await flight(verdict.since, 'b');
  chk(
    'the two reads really overlapped and settled out of order, otherwise this proves nothing',
    racedOutOfOrder(a, c),
    `a=${JSON.stringify(a)} b=${JSON.stringify(c)}`,
  );
}

console.log('\n=== REAL RACE: a second filter while the first read is in flight ===');
const sequence = await T('reticle_act_sequence', {
  steps: [
    { target: { testid: 'stale-race-filter-all' }, action: 'click' },
    { target: { testid: 'stale-race-filter-held' }, action: 'click' },
  ],
  burst: 50,
});
chk('both filter clicks ran', 2 === sequence.completed, `completed=${String(sequence.completed)}`);

// The older answer lands last. Wait for it on the page and in the session, so the check below sees
// the settled read and the render that applied it.
await p.locator('[data-testid="stale-race-rows"]', { hasText: 'all' }).waitFor({ timeout: 10000 });
await T('reticle_wait_for', {
  predicate: { kind: 'net', urlContains: `${ITEMS}?type=all`, method: 'GET', status: 200 },
  since: sequence.since,
  timeout_ms: 10000,
});
await sleep(100);

// `since` spans both clicks, and an assert carries no action, so this window is not one intent.
const verdict = await T('reticle_assert', {
  predicate: { kind: 'text', contains: 'Filter race' },
  since: sequence.since,
});
const kinds = kindsOf(verdict);
chk(
  'an older answer that lands last and is applied is reported as a stale response',
  kinds.includes(STALE),
  `verified=${String(verdict.verified)} kinds=${JSON.stringify(kinds)}`,
);
const older = await flight(sequence.since, 'all');
const newer = await flight(sequence.since, 'held');
chk(
  'the two reads really overlapped and settled out of order, otherwise this proves nothing',
  racedOutOfOrder(older, newer),
  `all=${JSON.stringify(older)} held=${JSON.stringify(newer)}`,
);
const shown = await p.evaluate(() => ({
  filter: document.querySelector('[data-testid="stale-race-filter"]')?.textContent,
  rows: document.querySelector('[data-testid="stale-race-rows"]')?.textContent,
}));
chk(
  'the control says held and the rows show the older answer',
  'held' === shown.filter && 'all' === shown.rows,
  JSON.stringify(shown),
);

await b.close();
console.log(
  `\n${fail === 0 ? '✅ STALE RESPONSE VERIFIED' : '❌ FAILED'} (${pass} passed, ${fail} failed)`,
);
process.exit(fail === 0 ? 0 : 1);
