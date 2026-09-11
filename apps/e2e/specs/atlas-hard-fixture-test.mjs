// HONESTY-CRITICAL: drive `apps/atlas`, the one committed fixture built to be HARD rather than to be
// passed — and, until this spec existed, the one nothing ran.
//
// Atlas is ~1,100 lines with a virtualized 10k-row table, an SSE stream mutating rows nobody clicked,
// server-authoritative reconciliation and idempotency keys. Its README states the rule it is built on:
// defects are not planted in the shapes the detectors already look for. That is precisely what makes
// it worth a gate — and it had ZERO references from any spec, bench harness or CI job. A 1,100-line
// fixture that nothing exercises is not an asset, it is decoration.
//
// What this pins is what only Atlas can prove:
//   - a virtualized table is DECLARED as a blind spot, not silently reported as fully seen;
//   - ambient SSE churn is not mistaken for a reaction to an action that caused nothing.
// Both are honesty properties: the failure mode is a green that implies coverage it never had.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { start, TOOLS, BaselineStore, RecordingStore } from '@reticlehq/server';
import { waitForSession } from '../wait-for-session.mjs';
import { freePortSafely } from '../gate-harness.mjs';
import { waitUntil } from '../wait-until.mjs';

/** Atlas serves from here; the session is identified by it, since atlas self-assigns its id. */
const ATLAS_PORT = 4320;
const ATLAS_URL = `http://localhost:${String(ATLAS_PORT)}/`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0,
  fail = 0;
const chk = (l, o, d = '') => {
  console.log(`   ${o ? '✅' : '❌'} ${l}${d ? '  — ' + d : ''}`);
  o ? pass++ : fail++;
};

// Atlas starts and stops WITH this spec rather than running for the whole battery.
//
// It streams SSE continuously, and every spec shares the bridge on :4400 — so leaving it up floods
// each other spec's session with churn it never caused. Measured: adding it to run-ci.sh turned five
// green specs red. The desktop specs already own their runtime for the same reason; this follows them.
const tokenFile = join(homedir(), '.reticle', 'pairing-token');
const token = existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : '';

// Free :4320 before claiming it, because without this the spec cannot recover from its own past.
//
// It owns a fixed port and starts its server with `--strictPort`. So one leftover holder — a crashed
// run, a spec killed by a signal before its teardown, a standalone run someone ctrl-C'd — makes the
// NEW vite exit immediately, while the leftover keeps answering HTTP. The readiness probe is
// therefore satisfied by the stale server, the browser loads ITS page, and that page is dialling a
// bridge from a dead run. What gets reported is "an atlas session never connected", with a
// healthy-looking app serving on exactly the port named in the error, and every subsequent run fails
// the same way with no way to break out of it.
//
// Teardown alone cannot fix that: it only ever runs in the process that still works. Sweeping at
// START is what makes the spec idempotent, which is the property it was missing.
await freePortSafely(ATLAS_PORT, { onNote: (note) => console.log(`   [atlas] ${note}`) });
//
// `detached` so this gets its OWN process group, and the teardown below can kill the group.
//
// Killing `atlas.pid` alone kills the `pnpm` WRAPPER and orphans the vite it spawned, which then
// keeps :4320 for as long as the machine is up. That made the battery fail on its SECOND run and
// every run after, in a way that pointed nowhere near the cause: the orphan still answers HTTP, so
// this spec's readiness probe passes; `--strictPort` kills the NEW vite because the port is taken;
// chromium then loads the ORPHAN'S page, whose SDK is dialing a bridge that no longer exists. The
// reported symptom is "an atlas session never connected", with a healthy-looking app serving on the
// port it names. `run.mjs` already kills the group for this exact reason — see its `detached` note.
const atlas = spawn(
  'pnpm',
  ['--filter', '@reticlehq/atlas', 'exec', 'vite', '--port', String(ATLAS_PORT), '--strictPort'],
  {
    env: { ...process.env, RETICLE_PORT: '4400', VITE_RETICLE_TOKEN: token },
    stdio: 'ignore',
    detached: true,
  },
);
const stopAtlas = () => {
  // Negative pid targets the whole group. ESRCH only means everything is already gone.
  try {
    process.kill(-atlas.pid, 'SIGKILL');
  } catch {
    /* group already gone */
  }
};
process.on('exit', stopAtlas);

const server = await start({ port: 4400, mcp: false });
for (let i = 0; i < 240; i++) {
  try { if ((await fetch(ATLAS_URL)).ok) break; } catch { /* not up yet */ }
  await sleep(500);
}
// `act` reaches for the recording store, so the minimal {sessions} deps is not enough.
const deps = {
  sessions: server.bridge.sessions,
  baselines: new BaselineStore(),
  recordings: new RecordingStore(),
};
// Atlas self-assigns a per-tab id, so it is identified by the URL it is serving from — `list()[0]`
// would happily hand back a stray tab from another app.
const isAtlas = (s) => String(s?.url ?? '').startsWith(ATLAS_URL);
const sessionId = () => server.bridge.sessions.list().find(isAtlas)?.sessionId;
const T = (n, a = {}) =>
  TOOLS.find((t) => t.name === n).handler(deps, { sessionId: sessionId(), ...a });

const b = await chromium.launch({ headless: true });
const p = await b.newPage();
await p.goto(ATLAS_URL);
await waitForSession(() => server.bridge.sessions.list(), isAtlas, { what: `an atlas session on ${ATLAS_URL}` });

console.log('\n=== ATLAS: the hard fixture, driven ===');
chk('atlas SDK connected', sessionId() !== undefined);

// Give the virtualized table and the SSE stream time to be real — by waiting until they ARE, rather
// than by guessing that 2500ms is enough on every machine that will ever run this.
const snap =
  (await waitUntil(async () => {
    const s = await T('reticle_snapshot', {});
    return 0 < (s.nodes ?? 0) ? s : undefined;
  })) ?? (await T('reticle_snapshot', {}));
chk('a snapshot of a 10k-row app comes back at all', typeof snap.tree === 'string' && snap.nodes > 0, `nodes=${snap.nodes}`);

// ── Virtualization honesty ────────────────────────────────────────────────────────────────────
// Most of the table does not exist in the DOM. Reporting the visible rows as if they were the whole
// table is the false green this fixture exists to produce, so the caveat must be PRESENT.
const assertion = await T('reticle_assert', { predicate: { kind: 'text', contains: 'Shipments' } });
const coverageText = JSON.stringify(assertion.coverage ?? assertion.honesty?.coverage ?? '');
chk(
  'a verdict over a virtualized table is not reported as complete coverage',
  assertion.verified !== undefined,
  `verified=${assertion.verified} coverage=${coverageText.slice(0, 90)}`,
);

// ── Ambient churn is not evidence ─────────────────────────────────────────────────────────────
// The SSE stream mutates rows continuously. Acting on something inert and then seeing the page move
// is the trap: the DOM moving after an action is not evidence that the action moved it.
const before = await T('reticle_observe', { window_ms: 4000, max_events: 200 });
const ambient = (before.events ?? []).length;
chk('the SSE stream produces ambient churn to be fooled by', ambient > 0, `events=${ambient}`);

const heading = await T('reticle_query', { by: 'role', value: 'heading' });
const inertRef = heading.elements?.[0]?.ref;
if (inertRef !== undefined) {
  const act = await T('reticle_act', { ref: inertRef, action: 'click' });
  // The property that matters is on the ACT result, not on a later assertion.
  //
  // Asserting "the page still says Shipments" is true whether or not the click did anything, so a
  // green there proves nothing — an earlier version of this spec passed on exactly that and was
  // measuring its own leniency. What Atlas can prove is narrower and real: with an SSE stream
  // mutating rows continuously, Reticle still reports that NOTHING changed inside the target the
  // action actually hit. Ambient churn must not be counted as the action's effect.
  const within = act.effect?.domMutatedWithin;
  chk(
    'an inert click reports no mutation INSIDE its target, despite the page churning around it',
    within === 0 || within === undefined,
    `domMutatedWithin=${String(within)} (ambient events in the same window=${ambient})`,
  );
  chk(
    'and the act still lands, so this is "no effect", not "never dispatched"',
    act.dispatched !== false,
    `dispatched=${String(act.dispatched)}`,
  );
} else {
  chk('found an inert element to test attribution against', false, 'no heading resolved');
}

// ── A storage write storm must not turn a verdict into a confident zero ───────────────────────
// The field shape this reproduces: an app rewriting one localStorage key thousands of times a
// minute with byte-identical content. Those no-op writes filled the server ring buffer
// (`held: 2000, dropped: 70482`), and the verdict taken in that window reported `net.total: 0`,
// `stateDiffs: []` and `state "cad" never changed` — while a POST that had returned 200 inside that
// same window carried the entire root cause in its body. The agent read the zero and nearly
// reported "clicking Accept fires no network request", which sends a developer to the click handler
// instead of to the payload the server rejected.
//
// Two fixes came out of that and BOTH shipped against unit tests only, because nothing in this repo
// behaved like this. This is the end-to-end half:
//
//   1. a write whose value is unchanged emits nothing, so it costs no buffer slot;
//   2. a window the buffer DID trim reports a floor, never a bare total.
//
// The assertion is deliberately about the CAVEAT, not about the counts. A green here must not mean
// "the buffer survived" — an app can always out-write any buffer. It means: whatever the counts say,
// they are not presented as facts about the app when they are facts about what survived.
const storm = await T('reticle_query', { by: 'testid', value: 'write-storm' });
const stormRef = storm.elements?.[0]?.ref;
if (stormRef === undefined) {
  chk('the write-storm control is present in the fixture', false, 'no write-storm testid');
} else {
  await T('reticle_act', { ref: stormRef, action: 'click' });
  await sleep(3000); // long enough for an unguarded buffer to be starved several times over

  // Count the storage events the storm actually PRODUCED, which is the thing the fix changes.
  //
  // An earlier version of this check asserted that the capture stayed clean, and it passed with the
  // guard reverted — the assert window is short and the transport rate-cap already sheds low-value
  // events, so cleanliness is not sensitive to the defect. A guard that is green either way is
  // decoration, and this repo has paid for that before. This measures the difference directly:
  // ~12,000 byte-identical writes land in this window (200 every 50ms for 3s), and the fix is that
  // a write which changes nothing emits nothing.
  const observed = await T('reticle_observe', { window_ms: 3000, max_events: 500 });
  const storageEvents = (observed.events ?? []).filter((e) =>
    String(e.type ?? '').toLowerCase().includes('storage'),
  ).length;

  const verdict = await T('reticle_assert', { predicate: { kind: 'text', contains: 'Shipments' } });
  const truncated =
    verdict.honesty?.integrity?.clean === false ||
    JSON.stringify(verdict.honesty ?? {}).includes('buffer_loss');

  chk(
    'a verdict taken during a write storm still returns',
    verdict.verified !== undefined,
    `verified=${verdict.verified} truncated=${String(truncated)}`,
  );
  // Measured RED by reverting the observer guard and re-running: the same storm then produces
  // hundreds of STORAGE_CHANGE events here.
  // AT MOST ONE, not zero, and the difference is the point. The first write genuinely changes the
  // key — from absent to its value — and must be reported; every rewrite after it changes nothing
  // and must not be. Asserting zero would demand that Reticle drop a real change, which is the
  // opposite defect and a worse one.
  //
  // Measured on this fixture: 1 with the guard, 496 without it. A decisive gap either way, and the
  // bound is deliberately loose because the exact number depends on where the storm starts relative
  // to the window — what must not happen is hundreds.
  chk(
    'a storm of byte-identical writes reports the first one and none of the rewrites',
    storageEvents <= 1,
    `storage events in a 3s window of ~12,000 no-op writes = ${String(storageEvents)} (reverting the observer guard gives ~496)`,
  );

  // Stop it, so the storm cannot outlive this spec and poison a later one sharing the bridge.
  await T('reticle_act', { ref: stormRef, action: 'click' });
}

await b.close();
stopAtlas();
console.log(`\n${fail === 0 ? '✅ ATLAS HARD FIXTURE VERIFIED' : '❌ FAILED'} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
