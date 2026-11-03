import { TEST_BRIDGE_PORT } from '../gate-harness.mjs';
// Four narrowed rules, in both directions, in a real browser (#2141).
//
// #1627 (`write-field-ignored`), #1629 (`action-had-no-effect`) and #2127 (`pagination-not-fetched`)
// each made a rule report less often. The merges took the merge queue's benchmark as the accuracy
// measurement, but no benchmark scenario or e2e spec exercised any of the three rules. A change that
// stopped a rule finding its defect would have passed every gate, and the agent would have read a
// broken app as verified.
//
// For each rule, one `reticle_act_and_wait` must report it and one must not. The control it must
// report is the defect closest to the shape the PR silenced, because that is where a narrowed rule
// goes wrong. Each direction also reads the session's own events, so a fixture that stops producing
// its shape fails here instead of passing for free.
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
const API = '/api/rule-pairs';
const WRITE_IGNORED = 'write-field-ignored';
const NO_EFFECT = 'action-had-no-effect';
const PAGINATION = 'pagination-not-fetched';
const PARTIAL_FAILURE = 'partial-failure-in-ok-response';
const PING_SAVED = `${API}/ping/saved`;
const PING_PATCHED = `${API}/ping/patched`;
const NET_REQUEST = 'net.request';
const NET_UNPATCHED = 'net.unpatched';
const VERIFIED_YES = 'yes';
const VERIFIED_UNKNOWN = 'unknown';
/** The words the engine's reason uses for a request sent through a `fetch` saved before connect. */
const SAVED_FETCH_REASON = 'saved before Reticle connected';
const BUILD_PLUGIN = 'build plugin';

const server = await start({ port: TEST_BRIDGE_PORT, mcp: false });
const reticleRoot = path.join(os.tmpdir(), `reticle-rule-pairs-${process.pid}`, '.reticle');
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
await p.goto(APP_URL, { waitUntil: 'domcontentloaded' });
await waitForSession(() => server.bridge.sessions.list(), isBench, {
  what: 'the bench-app session for the rule-pairs fixture',
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
await act('nav-rule-pairs', { kind: 'signal', name: 'nav:changed' });
// The mount reads page 1 of both lists. The rules below read both as the state before each click.
await p.locator('[data-testid="rule-pairs-page"]', { hasText: '1 of 6' }).waitFor();
await sleep(600);

/** The response body the session recorded for the write to `path` in the window. */
const echoOf = async (since, pathName) => {
  const write = (await events(since)).find(
    (e) => 'net.request' === e.type && String(e.data?.url ?? '').includes(`${API}/${pathName}`),
  );
  return String(write?.data?.responseBody ?? '');
};

console.log('\n=== write-field-ignored: an echo with the same id and the old values ===');
const save = await act('rule-pairs-save', {
  kind: 'net',
  urlContains: `${API}/profile`,
  method: 'POST',
  status: 200,
});
if (save !== undefined) {
  chk('the ignored write is reported', kindsOf(save).includes(WRITE_IGNORED), why(save));
  const body = await echoOf(save.since, 'profile');
  chk(
    'the echo kept the id and returned the old values, otherwise this proves nothing',
    body.includes('"profile-1"') && body.includes('Old name'),
    body,
  );
}

console.log('\n=== write-field-ignored: a new record with its own id is not an ignored write ===');
const duplicate = await act('rule-pairs-duplicate', {
  kind: 'net',
  urlContains: `${API}/derive`,
  method: 'POST',
  status: 200,
});
if (duplicate !== undefined) {
  chk('the new record is not reported', !kindsOf(duplicate).includes(WRITE_IGNORED), why(duplicate));
  const body = await echoOf(duplicate.since, 'derive');
  chk(
    'every compared field differs and the id is new, otherwise this proves nothing',
    body.includes('"profile-copy"') && body.includes('Copy of New name') && body.includes('trial'),
    body,
  );
}

console.log('\n=== write-field-ignored: a decimal echoed in its stored spelling is not ignored ===');
const price = await act('rule-pairs-price', {
  kind: 'net',
  urlContains: `${API}/price`,
  method: 'POST',
  status: 200,
});
if (price !== undefined) {
  chk('the stored spelling is not reported', !kindsOf(price).includes(WRITE_IGNORED), why(price));
  const body = await echoOf(price.since, 'price');
  chk('the echo really spelled 18.5 as 18.500, otherwise this proves nothing', body.includes('"18.500"'), body);
}

/** How many store changes moved `path` in the window. */
const storeMoves = async (since, pathName) =>
  (await events(since)).filter(
    (e) => 'state.change' === e.type && String(e.data?.path ?? '') === pathName,
  ).length;

console.log('\n=== action-had-no-effect: a dead click while a click counter moves its store path ===');
const dead = await act('rule-pairs-dead', { kind: 'settled' });
if (dead !== undefined) {
  chk('the dead click is reported', kindsOf(dead).includes(NO_EFFECT), why(dead));
  chk(
    'the click counter moved before the click and in its window, otherwise this proves nothing',
    0 < (await storeMoves(0, 'rulePairsClicks')) - (await storeMoves(dead.since, 'rulePairsClicks')) &&
      0 < (await storeMoves(dead.since, 'rulePairsClicks')),
  );
}

console.log('\n=== action-had-no-effect: a click whose effect is a quiet store path ===');
const remember = await act('rule-pairs-remember', { kind: 'settled' });
if (remember !== undefined) {
  chk('the store change counts as an effect', !kindsOf(remember).includes(NO_EFFECT), why(remember));
  chk(
    'the click moved its quiet store path once, otherwise this proves nothing',
    1 === (await storeMoves(remember.since, 'rulePairsChoice')),
  );
}

/** How many GETs asked `list` for page 1 in the window. */
const pageOneReads = async (since, list) =>
  (await events(since)).filter(
    (e) =>
      'net.request' === e.type && String(e.data?.url ?? '').includes(`${API}/${list}?page=1`),
  ).length;

console.log('\n=== pagination-not-fetched: a bare "1 of 6" label moves, page 1 is fetched again ===');
const next = await act('rule-pairs-next', {
  kind: 'net',
  urlContains: `${API}/pages?page=1`,
  method: 'GET',
  status: 200,
});
if (next !== undefined) {
  chk('the stalled pagination is reported', kindsOf(next).includes(PAGINATION), why(next));
  chk('the app asked for page 1 again', 1 === (await pageOneReads(next.since, 'pages')));
  chk('the label moved to 2 of 6', '2 of 6' === (await p.textContent('[data-testid="rule-pairs-page"]')));
}

console.log('\n=== pagination-not-fetched: a count that starts at 0 is not a page label ===');
const select = await act('rule-pairs-select', {
  kind: 'net',
  urlContains: `${API}/rows?page=1`,
  method: 'GET',
  status: 200,
});
if (select !== undefined) {
  chk('the selection count is not reported', !kindsOf(select).includes(PAGINATION), why(select));
  chk('the app asked for page 1 again', 1 === (await pageOneReads(select.since, 'rows')));
  chk(
    'the count moved from 0 to 1, otherwise this proves nothing',
    '1 of 6 selected' === (await p.textContent('[data-testid="rule-pairs-selected"]')),
  );
}

console.log('\n=== partial-failure-in-ok-response: a batch write answers 200 with one failed item ===');
const hold = await act('rule-pairs-batch', {
  kind: 'net',
  urlContains: `${API}/batch`,
  method: 'POST',
  status: 200,
});
if (hold !== undefined) {
  chk('the partial failure is reported', kindsOf(hold).includes(PARTIAL_FAILURE), why(hold));
  const body = await echoOf(hold.since, 'batch');
  chk('the batch really answered one failed item', body.includes('carrier_locked'), body);
}

console.log('\n=== partial-failure-in-ok-response: a read of old failed jobs is not a batch ===');
const jobs = await act('rule-pairs-jobs', {
  kind: 'net',
  urlContains: `${API}/jobs`,
  method: 'GET',
  status: 200,
});
if (jobs !== undefined) {
  chk('the job history is not reported', !kindsOf(jobs).includes(PARTIAL_FAILURE), why(jobs));
  const body = await echoOf(jobs.since, 'jobs');
  chk(
    'the list really held failed jobs, otherwise this proves nothing',
    body.includes('encode failed') && body.includes('source missing'),
    body,
  );
}

/** How many events of `type` named `url` the session recorded in the window. */
const recordsOf = async (since, type, url) =>
  (await events(since)).filter((e) => type === e.type && String(e.data?.url ?? '').includes(url))
    .length;

console.log('\n=== net miss over a fetch saved before connect: unknown, not no ===');
const saved = await act('rule-pairs-ping-saved', { kind: 'net', urlContains: PING_SAVED });
if (saved !== undefined) {
  const text = JSON.stringify(saved);
  chk('the miss is unknown', VERIFIED_UNKNOWN === saved.verified, why(saved));
  chk(
    'the reason names the saved fetch and the build plugin',
    text.includes(SAVED_FETCH_REASON) && text.includes(BUILD_PLUGIN),
    text.slice(0, 400),
  );
  chk(
    'the browser recorded the call and the patch did not, otherwise this proves nothing',
    1 <= (await recordsOf(saved.since, NET_UNPATCHED, PING_SAVED)) &&
      0 === (await recordsOf(saved.since, NET_REQUEST, PING_SAVED)),
  );
}

console.log('\n=== the same ping through window.fetch: yes, one record ===');
const patched = await act('rule-pairs-ping-patched', { kind: 'net', urlContains: PING_PATCHED });
if (patched !== undefined) {
  chk('the patched call is yes', VERIFIED_YES === patched.verified, why(patched));
  chk(
    'it has one request record and no marker, otherwise this proves nothing',
    1 === (await recordsOf(patched.since, NET_REQUEST, PING_PATCHED)) &&
      0 === (await recordsOf(patched.since, NET_UNPATCHED, PING_PATCHED)),
  );
}

await b.close();
console.log(
  `\n${fail === 0 ? '✅ NARROWED RULES VERIFIED' : '❌ FAILED'} (${pass} passed, ${fail} failed)`,
);
process.exit(fail === 0 ? 0 : 1);
