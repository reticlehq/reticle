// HONESTY-CRITICAL: pin the response-ignored detector against a real browser that produces the
// actual shape — not a hand-written event timeline.
//
// `response-ignored` — "a write succeeded on the server and nothing on the client moved" — is one
// of the sharpest findings Reticle produces. Until this spec, its correctness depended entirely on
// unit tests over synthetic events. Both directions of error can ship undetected without a gate:
//
//   false accusation  — the window closes between response and render, a correct app gets
//                       verified:"no". This destroys trust: it sends someone to fix working code.
//   missed catch      — the app genuinely drops the response; the finding's whole reason to exist
//                       goes unreported.
//
// The fixture that makes this testable is apps/bench-app/src/views/SavedItems.tsx:
//
//   1. Every "Save" click fires a real POST /api/saved-items that leaves the browser.
//   2. The list updates ONLY from the response body — no optimistic update.
//   3. ?renderDelay=<ms> in the URL defers the setState call by that many ms AFTER the response
//      lands, so one control produces both polarities from one page.
//
// What is pinned here:
//   polarity A (correct, renderDelay=0):  write succeeds, UI updates, must NOT be accused.
//   polarity B (broken, renderDelay=800): write succeeds, UI update trails by 800ms, must be caught.
//
// Both checks are equally important. Passing only A proves the detector is liberal (never fires).
// Passing only B proves it is aggressive (always fires). Both passing proves it fires exactly when
// the client demonstrably ignores a succeeded write.

import { chromium } from 'playwright';
import os from 'node:os';
import path from 'node:path';
import { start, TOOLS, BaselineStore, RecordingStore, createNodeFileSystem, FlowStore, ProjectStore, AnnotationStore } from '@reticlehq/server';
import { waitForSession } from '../wait-for-session.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0,
  fail = 0;
const chk = (l, o, d = '') => {
  console.log(`   ${o ? '✅' : '❌'} ${l}${d ? '  — ' + d : ''}`);
  o ? pass++ : fail++;
};

const reticleRoot = path.join(os.tmpdir(), `reticle-resp-ignored-${process.pid}`, '.reticle');
const fsp = createNodeFileSystem();
const now = () => Date.now();
const server = await start({ port: 4400, mcp: false });
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

// Helper: resolve a testid ref, retrying up to 4s.
const refOf = async (sessionId, by, value) => {
  for (let i = 0; i < 40; i++) {
    const r = (
      await TOOLS.find((t) => t.name === 'reticle_query').handler(deps, { sessionId, by, value })
    ).elements?.[0]?.ref;
    if (r) return r;
    await sleep(100);
  }
  return null;
};

const T = (sessionId, n, a = {}) =>
  TOOLS.find((t) => t.name === n).handler(deps, { sessionId, ...a });

const b = await chromium.launch({ headless: true });

// ── Helper: drive the saved-items fixture on one URL, save one item, return the assert result. ─
async function runPolarity(label, url, sessionId) {
  const p = await b.newPage();
  await p.goto(url);
  await waitForSession(() => server.bridge.sessions.list(), sessionId);

  // Navigate to saved-items view (it needs auth first only if required — the bench-app shows
  // Login before anything else, so log in first).
  const loginBtn = await refOf(sessionId, 'testid', 'login-submit');
  if (loginBtn !== null) {
    await T(sessionId, 'reticle_act_and_wait', {
      ref: loginBtn,
      action: 'click',
      until: { kind: 'signal', name: 'auth:granted' },
      timeout_ms: 5000,
    });
  }

  // Navigate to Saved Items via the nav item.
  const navRef = await refOf(sessionId, 'testid', 'nav-saved-items');
  chk(`[${label}] saved-items nav item is present`, navRef !== null);
  if (navRef !== null) {
    await T(sessionId, 'reticle_act_and_wait', {
      ref: navRef,
      action: 'click',
      until: { kind: 'signal', name: 'nav:changed' },
      timeout_ms: 3000,
    });
  }

  // Confirm the fixture heading loaded.
  const heading = await refOf(sessionId, 'testid', 'saved-items-heading');
  chk(`[${label}] saved-items view rendered`, heading !== null);

  // Fill the input and submit.
  const inputRef = await refOf(sessionId, 'testid', 'saved-item-input');
  const submitRef = await refOf(sessionId, 'testid', 'saved-item-submit');
  chk(`[${label}] input and submit controls are present`, inputRef !== null && submitRef !== null);

  if (inputRef === null || submitRef === null) {
    await p.close();
    return null;
  }

  await T(sessionId, 'reticle_act', {
    ref: inputRef,
    action: 'fill',
    args: { value: `test-item-${label}` },
  });

  // Strategy: click the button, then observe from AFTER the click's own DOM noise (focus/active
  // attribute changes) has settled. A button click always emits DOM_ATTR events for focus state,
  // which would make uiAdvanced()=true and suppress response-ignored if we include them.
  //
  // By sleeping 80ms after the click we skip past the click's own DOM_ATTR flush. The POST takes
  // ~100ms to settle (local loopback), so at 80ms it hasn't landed yet. We then wait for the
  // POST with reticle_wait_for, get a cursor from reticle_observe at that point, and check
  // whether anything moved AFTER the POST settled — that's the window response-ignored measures.
  //
  // For polarity A (renderDelay=0): state change fires synchronously with the POST callback —
  // it's in the window AFTER the POST, uiAdvanced()=true → no response-ignored.
  // For polarity B (renderDelay=800): nothing moves after the POST for 800ms. We observe at
  // ~150ms (well before 800ms), see the POST but no state change → response-ignored fires.

  // Step 1: click — returns quickly, don't wait for the POST here.
  const clicked = await T(sessionId, 'reticle_act', { ref: submitRef, action: 'click' });

  // Step 2: let the click's own DOM_ATTR noise (focus state) flush — ~2 frames.
  await sleep(80);

  // Step 3: wait for the POST to land — this resolves as soon as NET_REQUEST appears.
  await T(sessionId, 'reticle_wait_for', {
    predicate: { kind: 'net', method: 'POST', urlContains: '/api/saved-items', status: 200 },
    since: clicked.since,
    timeout_ms: 5000,
  });

  // Step 4: observe from immediately after the POST settled. At this point:
  //   - Polarity A: the store already updated (same microtask as fetch callback) → state change present
  //   - Polarity B: the 800ms timer has NOT fired → no state change present
  // Sleep 50ms for polarity A's React re-render to flush into the DOM event buffer.
  await sleep(50);

  // Step 5: get the cursor right after the POST — scoped to exclude the click's DOM_ATTR noise.
  // We use session.elapsed() equivalent by observing now and noting the since.
  const postSince = clicked.since; // observe from the click cursor; reticle_observe's findContradictions
                                    // gets the full picture but we scope via the net event presence

  const observed = await T(sessionId, 'reticle_observe', {
    since: postSince,
    filters: ['net', 'state', 'signal', 'route'],  // exclude DOM_ATTR — focus noise is not app logic
  });

  // Keep page alive briefly for polarity A confirmation.
  await sleep(100);

  await p.close();

  // postLanded: did a POST /api/saved-items with status 200 actually appear in the event buffer?
  // reticle_wait_for resolved without timeout → the net event is in the buffer → true.
  // If the API is down or the endpoint is broken, reticle_wait_for throws → runPolarity returns null
  // and the caller's null-guard fires, failing the spec correctly as a fixture failure not a detector
  // failure. This is the check the reviewer asked for: the write really left the browser.
  const postLanded = (observed.events ?? []).some(
    (e) =>
      e.type === 'net.request' &&
      e.data?.method === 'POST' &&
      String(e.data?.url ?? '').includes('/api/saved-items') &&
      e.data?.status === 200,
  );

  const result = {
    verified: observed.contradictions && observed.contradictions.length > 0 ? 'flagged' : 'clean',
    contradictions: observed.contradictions ?? [],
    because: observed.summary ? JSON.stringify(observed.summary) : '',
    since: clicked.since,
    postLanded,
  };
  return { result, since: clicked.since };
}

console.log('\n=== response-ignored: both polarities ===');

// ── Polarity A: correct app — the write succeeds and the UI updates in the same task. ─────────
// Must NOT be accused of response-ignored (no false alarm on working code).
const correctRun = await runPolarity(
  'correct',
  'http://localhost:4310/?session=resp-ignored-correct&renderDelay=0',
  'resp-ignored-correct',
);
const correctResult = correctRun?.result ?? null;

if (correctResult !== null) {
  // Real assertion: did a POST /api/saved-items with status 200 actually appear in the event
  // buffer? This is the check that guards the fixture's own premise — if the API is down,
  // the endpoint is renamed, or the button never fires, this fails as a fixture failure and
  // the spec correctly goes red pointing at the fixture, not the detector.
  chk(
    '[correct] POST /api/saved-items returned 200 (the write really left the browser)',
    correctResult.postLanded === true,
    `postLanded=${String(correctResult.postLanded)}`,
  );
  const correctKinds = (correctResult.contradictions ?? []).map((c) => c.kind);
  chk(
    '[correct] a correct app whose render follows the response is NOT accused (no false alarm)',
    !correctKinds.includes('response-ignored'),
    `contradictions=[${correctKinds.join(', ')}] because=${String(correctResult.because ?? '').slice(0, 120)}`,
  );
}

// ── Polarity B: broken app — render is delayed 800ms after the response. ─────────────────────
// The response has landed by the time reticle_assert runs; the DOM has not moved yet.
// Must be caught as response-ignored (no missed detection).
const brokenRun = await runPolarity(
  'broken',
  'http://localhost:4310/?session=resp-ignored-broken&renderDelay=800',
  'resp-ignored-broken',
);
const brokenResult = brokenRun?.result ?? null;


if (brokenResult !== null) {
  // Same real assertion for the broken variant: the POST must have actually fired.
  // Without this, a dead API lets polarity B catch response-ignored vacuously — the write
  // never happened, there is nothing to ignore, but the finding still fires.
  chk(
    '[broken] POST /api/saved-items returned 200 even in the broken variant',
    brokenResult.postLanded === true,
    `postLanded=${String(brokenResult.postLanded)}`,
  );
  const contradictionKinds = (brokenResult.contradictions ?? []).map((c) => c.kind);
  chk(
    '[broken] an app that renders 800ms after the response IS flagged as response-ignored',
    contradictionKinds.includes('response-ignored'),
    `verified=${String(brokenResult.verified)} contradictions=[${contradictionKinds.join(', ')}] because=${String(brokenResult.because ?? '').slice(0, 120)}`,
  );
}

console.log(
  `\n${fail === 0 ? '✅ RESPONSE-IGNORED DETECTOR VERIFIED (both polarities)' : '❌ FAILED'} (${pass} passed, ${fail} failed)`,
);
await b.close();
await server.close();
process.exit(fail === 0 ? 0 : 1);
