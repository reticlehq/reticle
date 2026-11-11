import { TEST_BRIDGE_PORT } from '../gate-harness.mjs';
// Narrowed rules, in both directions, in a real browser (#2141, #2175).
//
// #1627 (`write-field-ignored`), #1629 (`action-had-no-effect`) and #2127 (`pagination-not-fetched`)
// each made a rule report less often. The merges took the merge queue's benchmark as the accuracy
// measurement, but no benchmark scenario or e2e spec exercised any of the three rules. A change that
// stopped a rule finding its defect would have passed every gate, and the agent would have read a
// broken app as verified.
//
// #2172 narrowed `signal-contradicted`: a signal sent before a declared failed write is no longer a
// claim about it. The pair below keeps the claim that follows the failure.
//
// #2175 narrowed `stale-response-applied` to responses that update the same target. The pair below
// keeps the same-target defect while proving that two unrelated store keys remain a pass.
//
// For each rule, one `reticle_act_and_wait` must report it and one must not. The control it must
// report is the defect closest to the shape the PR silenced, because that is where a narrowed rule
// goes wrong. Each direction also reads the session's own events, so a fixture that stops producing
// its shape fails here instead of passing for free.
//
// The reach cases at the end hold a fifth rule in the same way: a click that no person can make is
// never `yes` (#1518).
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
import { EventType, Verified, VerifiedReason } from '@reticlehq/core';
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
const VERIFIED_NO = 'no';
const SIGNAL_CONTRADICTED = 'signal-contradicted';
const SIGNAL = 'signal';
const NET_PENDING = 'net.pending';
const INVITE = `${API}/invite`;
const FORM_SUBMIT = 'form:submit';
const INVITE_SENT = 'invite:sent';
const STALE_RESPONSE = 'stale-response-applied';
const OPTIONS = `${API}/options`;
const SAME_TASK_MS = 2;
/** The words the engine's reason uses for a request sent through a `fetch` saved before connect. */
const SAVED_FETCH_REASON = 'saved before Reticle connected';
const BUILD_PLUGIN = 'build plugin';
const PUBLISH_QUESTION = 'Publish this profile?';

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

/** When one options read was issued and settled, from the session's own events. */
const optionFlight = async (since, query) => {
  const recorded = await events(since);
  const at = (type) =>
    recorded.find(
      (e) => type === e.type && String(e.data?.url ?? '').includes(`${OPTIONS}?${query}`),
    )?.t;
  return { issued: at('net.pending'), settled: at('net.request') };
};

const racedOutOfOrder = (first, second) =>
  second.issued - first.issued >= SAME_TASK_MS &&
  second.issued < first.settled &&
  second.settled < first.settled;

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

console.log('\n=== stale-response-applied: out-of-order reads update different store keys ===');
const options = await T('reticle_act_sequence', {
  steps: [
    { target: { testid: 'rule-pairs-options-gender' }, action: 'click' },
    { target: { testid: 'rule-pairs-options-state' }, action: 'click' },
  ],
  burst: 50,
});
chk('both option reads ran', 2 === options.completed, `completed=${String(options.completed)}`);
await p
  .locator('[data-testid="rule-pairs-gender-options"]', { hasText: 'gender' })
  .waitFor({ timeout: 10000 });
await T('reticle_wait_for', {
  predicate: { kind: 'net', urlContains: `${OPTIONS}?kind=gender`, method: 'GET', status: 200 },
  since: options.since,
  timeout_ms: 10000,
});
await sleep(100);
const separateTargets = await T('reticle_assert', {
  predicate: { kind: 'text', contains: 'gender options' },
  since: options.since,
});
chk('different store keys remain verified yes', VERIFIED_YES === separateTargets.verified, why(separateTargets));
chk(
  'each response moved its own store key',
  1 === (await storeMoves(options.since, 'rulePairsGenderOptions')) &&
    1 === (await storeMoves(options.since, 'rulePairsStateOptions')),
);
const gender = await optionFlight(options.since, 'kind=gender');
const state = await optionFlight(options.since, 'kind=state');
chk(
  'the option reads overlapped and settled out of order',
  racedOutOfOrder(gender, state),
  `gender=${JSON.stringify(gender)} state=${JSON.stringify(state)}`,
);

console.log('\n=== stale-response-applied: out-of-order reads overwrite shipments.rows ===');
const shipments = await T('reticle_act_sequence', {
  steps: [
    { target: { testid: 'rule-pairs-shipments-all' }, action: 'click' },
    { target: { testid: 'rule-pairs-shipments-held' }, action: 'click' },
  ],
  burst: 50,
});
chk('both shipment reads ran', 2 === shipments.completed, `completed=${String(shipments.completed)}`);
await p
  .locator('[data-testid="rule-pairs-shipments"]', { hasText: 'all shipments' })
  .waitFor({ timeout: 10000 });
await T('reticle_wait_for', {
  predicate: { kind: 'net', urlContains: `${OPTIONS}?status=all`, method: 'GET', status: 200 },
  since: shipments.since,
  timeout_ms: 10000,
});
await sleep(100);
const sameTarget = await T('reticle_assert', {
  predicate: { kind: 'text', contains: 'all shipments' },
  since: shipments.since,
});
chk('an older response overwriting shipments.rows is verified no', VERIFIED_NO === sameTarget.verified, why(sameTarget));
chk('the stale response is reported', kindsOf(sameTarget).includes(STALE_RESPONSE), why(sameTarget));
chk('both responses moved shipments.rows', 2 === (await storeMoves(shipments.since, 'shipments')));
const allShipments = await optionFlight(shipments.since, 'status=all');
const heldShipments = await optionFlight(shipments.since, 'status=held');
chk(
  'the shipment reads overlapped and settled out of order',
  racedOutOfOrder(allShipments, heldShipments),
  `all=${JSON.stringify(allShipments)} held=${JSON.stringify(heldShipments)}`,
);
console.log('\n=== dialog_declined: a publish behind confirm() that Reticle declined ===');
const publishUntil = { kind: 'net', urlContains: `${API}/publish`, method: 'POST', status: 200 };
const declined = await act('rule-pairs-publish', publishUntil);
if (declined !== undefined) {
  chk(
    'the verdict is unknown, not no',
    Verified.UNKNOWN === declined.verified &&
      VerifiedReason.DIALOG_DECLINED === declined.verifiedReason,
    `${why(declined)} reason=${String(declined.verifiedReason)}`,
  );
  chk('the reason quotes the question', String(declined.because).includes(PUBLISH_QUESTION));
  const dialogs = (await events(declined.since)).filter(
    (e) => EventType.DIALOG_OPENED === e.type && false === e.data?.answered,
  );
  chk('the page recorded the declined confirm, otherwise this proves nothing', 1 === dialogs.length);
}

console.log('\n=== dialog_declined: a dead click with no dialog is still no ===');
const deadPublish = await act('rule-pairs-dead', publishUntil);
if (deadPublish !== undefined) {
  chk(
    'the verdict is no',
    Verified.NO === deadPublish.verified &&
      VerifiedReason.ASSERTION_FAILED === deadPublish.verifiedReason,
    `${why(deadPublish)} reason=${String(deadPublish.verifiedReason)}`,
  );
  const dialogs = (await events(deadPublish.since)).filter((e) => EventType.DIALOG_OPENED === e.type);
  chk('no dialog opened, otherwise this proves nothing', 0 === dialogs.length);
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

// Reach: a click that no person can make must not give `yes` (#1518). Synthetic dispatch still
// reaches the control, so its request fires and the declared consequence holds. The verdict must be
// undecided, and its reason must name why. A control that a person can reach, with the same `until`,
// must still give `yes`. Each case also counts the request, so a control that stops sending it fails
// here instead of passing for free.
const TOGGLE = { kind: 'net', method: 'POST', urlContains: `${API}/toggle`, status: 200 };
const OVERLAY_ID = 'rule-pairs-overlay';
const REACH = [
  {
    what: 'a switch inside a closed <details>',
    target: { role: 'switch', name: 'Stream eligible' },
    because: 'it is not visible',
  },
  {
    what: 'a button under a full-screen overlay',
    target: { role: 'button', name: 'Publish roster' },
    because: 'covered by div',
    covered: true,
  },
  {
    what: 'a switch inside a display: none panel',
    target: { role: 'switch', name: 'Stream archived' },
    because: 'has no size',
  },
];
const OPEN = { role: 'switch', name: 'Stream public' };

const toggles = async (since) =>
  (await events(since)).filter(
    (e) => 'net.request' === e.type && String(e.data?.url ?? '').includes(`${API}/toggle`),
  ).length;
const verdictOf = (r) =>
  `verified=${String(r?.verified)} reason=${String(r?.verifiedReason ?? '')} because=${String(r?.because ?? '').slice(0, 140)}`;
/** Put an opaque full-screen layer over the page, or take it away. */
const cover = (on) =>
  p.evaluate(
    ([id, show]) => {
      document.getElementById(id)?.remove();
      if (show) {
        const div = document.createElement('div');
        div.id = id;
        div.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#fff;';
        document.body.appendChild(div);
      }
    },
    [OVERLAY_ID, on],
  );
const tools = [
  {
    tool: 'act_and_wait',
    run: (target) =>
      T('reticle_act_and_wait', { target, action: 'click', until: TOGGLE, timeout_ms: 8000 }),
  },
  {
    tool: 'act { steps }',
    run: (target) =>
      T('reticle_act_sequence', { steps: [{ target, action: 'click', expect: TOGGLE }] }),
  },
];

for (const c of REACH) {
  for (const { tool, run } of tools) {
    console.log(`\n=== reach (${tool}): ${c.what} ===`);
    if (true === c.covered) {
      await cover(true);
    }
    const r = await run(c.target);
    if (true === c.covered) {
      await cover(false);
    }
    chk('the click is not verified yes', VERIFIED_YES !== r?.verified, verdictOf(r));
    chk('the reason says why a person could not click it', String(r?.because ?? '').includes(c.because));
    chk(
      'the click really sent its request, otherwise this proves nothing',
      1 === (await toggles(r?.since ?? 0)),
    );
  }
}

for (const { tool, run } of tools) {
  console.log(`\n=== reach (${tool}): a switch a person can reach, with the same until ===`);
  const r = await run(OPEN);
  chk('the click is verified yes', VERIFIED_YES === r?.verified, verdictOf(r));
  chk('the click sent its request', 1 === (await toggles(r?.since ?? 0)));
}

/** The sequence number of the first event of `type` that `match` accepts in the window. */
const seqOf = async (since, type, match) =>
  (await events(since)).find((e) => type === e.type && match(e))?.seq;
const signalSeq = (since, name) => seqOf(since, SIGNAL, (e) => name === e.data?.name);
const inviteSentSeq = (since) =>
  seqOf(since, NET_PENDING, (e) => String(e.data?.url ?? '').includes(INVITE));
const declared409 = { kind: 'net', urlContains: INVITE, method: 'POST', status: 409 };

console.log('\n=== signal-contradicted: a declared 409 after a signal sent before the request ===');
const early = await act('rule-pairs-invite-early', declared409);
if (early !== undefined) {
  chk('the declared 409 is yes', VERIFIED_YES === early.verified, why(early));
  chk('the early signal is not reported', !kindsOf(early).includes(SIGNAL_CONTRADICTED), why(early));
  const signalled = await signalSeq(early.since, FORM_SUBMIT);
  const sentAt = await inviteSentSeq(early.since);
  chk(
    'the signal was recorded before the invite was sent, otherwise this proves nothing',
    signalled !== undefined && sentAt !== undefined && signalled < sentAt,
    `signal=${String(signalled)} sent=${String(sentAt)}`,
  );
}

console.log('\n=== signal-contradicted: a success signal after the declared 409 ===');
const claimed = await act('rule-pairs-invite-claimed', declared409);
if (claimed !== undefined) {
  chk('the claim over the 409 is no', VERIFIED_NO === claimed.verified, why(claimed));
  chk('the claim is reported', kindsOf(claimed).includes(SIGNAL_CONTRADICTED), why(claimed));
  const signalled = await signalSeq(claimed.since, INVITE_SENT);
  const sentAt = await inviteSentSeq(claimed.since);
  chk(
    'the signal was recorded after the invite was sent, otherwise this proves nothing',
    signalled !== undefined && sentAt !== undefined && signalled > sentAt,
    `signal=${String(signalled)} sent=${String(sentAt)}`,
  );
}

// An optimistic lock (#2174): the server bumps `lock_version`, so the echo never repeats the token
// that was sent. The bump is the proof that the write applied, and must not give `no`. A title that
// the server did not keep, under the same bump, must still give `no`.
const lockUntil = (outcome) => ({
  kind: 'net',
  urlContains: `${API}/lock/${outcome}`,
  method: 'PUT',
  status: 200,
});

console.log('\n=== write-field-ignored: a PUT that bumps lock_version and keeps the title ===');
const kept = await act('rule-pairs-lock-kept', lockUntil('kept'));
if (kept !== undefined) {
  chk('the bumped lock is verified yes', VERIFIED_YES === kept.verified, why(kept));
  const body = await echoOf(kept.since, 'lock/kept');
  chk(
    'the echo bumped lock_version 3 to 4 and kept the title, otherwise this proves nothing',
    body.includes('"lock_version":4') && body.includes('Q3 plan'),
    body,
  );
}

console.log('\n=== write-field-ignored: the same PUT whose echo keeps an old title ===');
const lost = await act('rule-pairs-lock-lost', lockUntil('lost'));
if (lost !== undefined) {
  chk('the ignored title is verified no', VERIFIED_NO === lost.verified, why(lost));
  chk('the ignored title is reported', kindsOf(lost).includes(WRITE_IGNORED), why(lost));
  const body = await echoOf(lost.since, 'lock/lost');
  chk(
    'the echo bumped lock_version and returned the old title, otherwise this proves nothing',
    body.includes('"lock_version":4') && body.includes('Old title'),
    body,
  );
}

await b.close();
console.log(
  `\n${fail === 0 ? '✅ NARROWED RULES VERIFIED' : '❌ FAILED'} (${pass} passed, ${fail} failed)`,
);
process.exit(fail === 0 ? 0 : 1);
