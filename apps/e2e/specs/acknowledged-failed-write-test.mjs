import { TEST_BRIDGE_PORT } from '../gate-harness.mjs';
// An acknowledged failed write, in both directions, in a real browser (#2173).
//
// `ui-advanced-request-failed` reports a UI that moved while a write failed. It now reports less: a
// store that records the failed call's HTTP status acknowledges the failure. A 429 kept as
// `status: 429` beside a retry message is `yes`. The same 429 while the store says `sent: true`
// stays `no`, and so does an order that fails with a 500 while the page says it was saved.
// Error text that the app writes into an alert region already on the page also acknowledges the
// failure: a 401 with "Wrong email or password" there is `yes`. The same 401 while a plain element
// says "Welcome back" and the store says `signedIn: true` stays `no`.
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
const API = '/api/ack-pairs';
const UI_ADVANCED_REQUEST_FAILED = 'ui-advanced-request-failed';
const NET_REQUEST = 'net.request';
const STATE_CHANGE = 'state.change';
const VERIFIED_YES = 'yes';
const VERIFIED_NO = 'no';
const TOO_MANY = 429;
const SERVER_ERROR = 500;
const UNAUTHORIZED = 401;
const DOM_TEXT = 'dom.text';
const LIVE_ASSERTIVE = 'assertive';
const WRONG_PASSWORD = 'Wrong email or password';
const ORDER = `${API}/order`;

const server = await start({ port: TEST_BRIDGE_PORT, mcp: false });
const reticleRoot = path.join(os.tmpdir(), `reticle-ack-pairs-${process.pid}`, '.reticle');
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
  `verified=${String(verdict.verified)} kinds=${JSON.stringify(kindsOf(verdict))}`;

const b = await chromium.launch({ headless: true });
const p = await b.newPage();
// The fixture views are opt-in, so the benchmark page has no link to them (fixture-views.ts).
await p.goto(`${APP_URL}?fixture-views=1`, { waitUntil: 'domcontentloaded' });
await waitForSession(() => server.bridge.sessions.list(), isBench, {
  what: 'the bench-app session for the ack-pairs fixture',
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

/** The statuses of the requests to `url` that the session recorded since `since`. */
const statusesOf = async (since, url) =>
  (await events(since))
    .filter((e) => NET_REQUEST === e.type && String(e.data?.url ?? '').endsWith(url))
    .map((e) => e.data?.status);

/** The store values written to `pathName` since `since`. */
const storedAt = async (since, pathName) =>
  (await events(since))
    .filter((e) => STATE_CHANGE === e.type && String(e.data?.path ?? '') === pathName)
    .map((e) => e.data?.value);

const loginBtn = await refOf('login-submit');
if (loginBtn !== undefined) {
  await T('reticle_act_and_wait', {
    ref: loginBtn,
    action: 'click',
    until: { kind: 'signal', name: 'auth:granted' },
    timeout_ms: 5000,
  });
}
await act('nav-ack-pairs', { kind: 'signal', name: 'nav:changed' });

const invitePath = (verdict, suffix) => statusesOf(verdict.since, `${API}/${suffix}`);

console.log('\n=== the store records the 429 status beside a retry message ===');
const retry = await act('ack-pairs-invite-retry', {
  kind: 'text',
  contains: 'Try again in a minute',
});
if (retry !== undefined) {
  chk('the acknowledged 429 is yes', VERIFIED_YES === retry.verified, why(retry));
  chk('the rule is silent', !kindsOf(retry).includes(UI_ADVANCED_REQUEST_FAILED), why(retry));
  chk(
    'the invite answered 429, otherwise this proves nothing',
    (await invitePath(retry, 'invite-retry')).includes(TOO_MANY),
  );
  const stored = await storedAt(retry.since, 'ackInvite');
  chk(
    'the store recorded status 429, otherwise this proves nothing',
    stored.some((v) => TOO_MANY === v?.status),
    JSON.stringify(stored),
  );
}

console.log('\n=== the same 429 while the store says the invite was sent ===');
const claimed = await act('ack-pairs-invite-claimed', { kind: 'text', contains: 'Invitation sent' });
if (claimed !== undefined) {
  chk('the hidden 429 is no', VERIFIED_NO === claimed.verified, why(claimed));
  chk('the rule reports it', kindsOf(claimed).includes(UI_ADVANCED_REQUEST_FAILED), why(claimed));
  chk(
    'the invite answered 429, otherwise this proves nothing',
    (await invitePath(claimed, 'invite-claimed')).includes(TOO_MANY),
  );
}

console.log('\n=== an order that fails with a 500 while the page says it was saved ===');
const order = await act('ack-pairs-order', { kind: 'text', contains: 'Order saved' });
if (order !== undefined) {
  chk('the hidden 500 is no', VERIFIED_NO === order.verified, why(order));
  chk('the rule reports it', kindsOf(order).includes(UI_ADVANCED_REQUEST_FAILED), why(order));
  chk(
    'the order answered 500 only in this window, otherwise this proves nothing',
    (await statusesOf(order.since, ORDER)).includes(SERVER_ERROR) &&
      0 === (await statusesOf(0, ORDER)).length - (await statusesOf(order.since, ORDER)).length,
  );
}

console.log('\n=== a 401 whose error text lands in an alert region already on the page ===');
const refused = await act('ack-pairs-login', { kind: 'text', contains: WRONG_PASSWORD });
if (refused !== undefined) {
  chk('the acknowledged 401 is yes', VERIFIED_YES === refused.verified, why(refused));
  chk('the rule is silent', !kindsOf(refused).includes(UI_ADVANCED_REQUEST_FAILED), why(refused));
  chk(
    'the sign-in answered 401, otherwise this proves nothing',
    (await statusesOf(refused.since, `${API}/login`)).includes(UNAUTHORIZED),
  );
  const texts = (await events(refused.since)).filter((e) => DOM_TEXT === e.type);
  chk(
    'the text arrived as an assertive text change, not a mount, otherwise this proves nothing',
    texts.some((e) => WRONG_PASSWORD === e.data?.text && LIVE_ASSERTIVE === e.data?.live),
    JSON.stringify(texts.map((e) => e.data)),
  );
}

console.log('\n=== the same 401 while a plain element says welcome and the store signs in ===');
const welcomed = await act('ack-pairs-login-claimed', { kind: 'text', contains: 'Welcome back' });
if (welcomed !== undefined) {
  chk('the hidden 401 is no', VERIFIED_NO === welcomed.verified, why(welcomed));
  chk('the rule reports it', kindsOf(welcomed).includes(UI_ADVANCED_REQUEST_FAILED), why(welcomed));
  chk(
    'the sign-in answered 401, otherwise this proves nothing',
    (await statusesOf(welcomed.since, `${API}/login-claimed`)).includes(UNAUTHORIZED),
  );
  const stored = await storedAt(welcomed.since, 'ackLogin');
  chk(
    'the store says signed in, otherwise this proves nothing',
    stored.some((v) => true === v?.signedIn),
    JSON.stringify(stored),
  );
}

await b.close();
console.log(
  `\n${fail === 0 ? '✅ ACKNOWLEDGED FAILED WRITES VERIFIED' : '❌ FAILED'} (${pass} passed, ${fail} failed)`,
);
process.exit(fail === 0 ? 0 : 1);
