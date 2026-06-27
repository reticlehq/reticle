/**
 * Before/after benchmark for the builder pitch. For each silent-failure class the "generated app"
 * can ship, it compares two QA gates against the SAME live preview:
 *
 *   • BLIND gate   — what a pre-Iris pipeline sees: the page returns 200 and the Add POST returns 200.
 *                    This is the honest floor for "screenshot / HTTP-status" QA — it has no view of
 *                    program truth (state, network cardinality, console, UI-vs-data).
 *   • IRIS gate    — the in-process API-style agent driving a headless sandbox (qa/verify-live.mjs).
 *
 * Output: a per-class table + a stats summary written to scratch/stats.json. Everything is MEASURED
 * live, not asserted — the only modelled part is the blind gate, which we keep deliberately honest.
 *
 *   PREVIEW_URL=http://localhost:4318 BRIDGE_PORT=4422 node qa/bench.mjs
 */
import { verifyPreview } from './verify-live.mjs';

const PREVIEW_URL = process.env.PREVIEW_URL ?? 'http://localhost:4310';
const BRIDGE_PORT = Number(process.env.BRIDGE_PORT ?? 4400);

const BUGS = [
  { id: 'none', label: 'fully working app', silent: false },
  { id: 'mock-data', label: 'POST 200 but never persists', silent: true },
  { id: 'double-submit', label: 'Add fires the POST twice', silent: true },
  { id: 'console-error', label: 'console error, UI renders fine', silent: true },
  { id: 'no-validation', label: '"abc" accepted as an amount', silent: true },
  { id: 'dead-delete', label: 'DELETE 200 but never removes', silent: true },
  { id: 'wrong-total', label: 'displayed Total lies vs data', silent: true },
];

/** The blind gate: HTTP-200 + render, the pre-Iris floor. Returns 'pass' | 'fail'. */
async function blindGate(bug) {
  const page = await fetch(`${PREVIEW_URL}/?bug=${bug}`);
  await fetch(`${PREVIEW_URL}/api/reset`, { method: 'DELETE', headers: { 'x-bug': bug } });
  const post = await fetch(`${PREVIEW_URL}/api/expenses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bug': bug },
    body: JSON.stringify({ amount: '42', category: 'food', note: '' }),
  });
  // The page renders and the write "succeeds" (200) — which is all this gate can check.
  return page.ok && post.ok ? 'pass' : 'fail';
}

const rows = [];
for (const bug of BUGS) {
  const blind = await blindGate(bug.id);
  const iris = await verifyPreview({ bug: bug.id, previewUrl: PREVIEW_URL, bridgePort: BRIDGE_PORT });
  const caughtBy = iris.checks.filter((c) => c.status === 'fail').map((c) => c.name);
  rows.push({ bug: bug.id, label: bug.label, silent: bug.silent, blind, iris: iris.status, caughtBy });
}

// ── Table ─────────────────────────────────────────────────────────────────────
const mark = (v) => (v === 'pass' ? 'PASS' : 'FAIL');
const pad = (s, n) => String(s).padEnd(n);
console.log('\n┌─ the builder QA gate comparison ─ generated Expense Tracker ─────────────────────');
console.log(`│ ${pad('bug class', 16)} ${pad('blind QA', 9)} ${pad('Iris QA', 8)} verdict`);
console.log('├──────────────────────────────────────────────────────────────────────────────');
for (const r of rows) {
  const verdict =
    r.bug === 'none'
      ? r.iris === 'pass'
        ? 'correct PASS'
        : 'FALSE ALARM'
      : r.iris === 'fail'
        ? `caught (${r.caughtBy[0] ?? '?'})`
        : 'MISSED';
  console.log(`│ ${pad(r.bug, 16)} ${pad(mark(r.blind), 9)} ${pad(mark(r.iris), 8)} ${verdict}`);
}
console.log('└──────────────────────────────────────────────────────────────────────────────');

// ── Stats ─────────────────────────────────────────────────────────────────────
const silent = rows.filter((r) => r.silent);
const irisCaught = silent.filter((r) => r.iris === 'fail').length;
const blindCaught = silent.filter((r) => r.blind === 'fail').length;
const cleanRow = rows.find((r) => r.bug === 'none');
const stats = {
  silentFailureClasses: silent.length,
  irisDetected: irisCaught,
  irisDetectionRate: `${Math.round((irisCaught / silent.length) * 100)}%`,
  blindDetected: blindCaught,
  blindDetectionRate: `${Math.round((blindCaught / silent.length) * 100)}%`,
  escapedDefectsBlind: silent.length - blindCaught,
  escapedDefectsIris: silent.length - irisCaught,
  falsePositivesIris: cleanRow?.iris === 'pass' ? 0 : 1,
  oneShotGreenLightHonest: {
    description:
      'Of the silent-failure builds, how many a gate would (wrongly) green-light for the user.',
    blindGreenLit: silent.filter((r) => r.blind === 'pass').length,
    irisGreenLit: silent.filter((r) => r.iris === 'pass').length,
  },
};
console.log('\n=== stats ===');
console.log(JSON.stringify(stats, null, 2));

// Persist for the meeting doc / builder UI.
const out = { generatedAt: null, previewUrl: PREVIEW_URL, rows, stats };
const fs = await import('node:fs/promises');
const path = `${process.cwd()}/qa/last-bench.json`;
await fs.writeFile(path, `${JSON.stringify(out, null, 2)}\n`);
console.log(`\nwrote ${path}`);

// Gate: the demo's headline must hold — Iris catches all silent classes, blind none, no false positives.
const ok = stats.irisDetected === silent.length && stats.blindDetected === 0 && stats.falsePositivesIris === 0;
if (!ok) console.error('\n✗ bench gate failed — expected Iris 6/6, blind 0/6, 0 false positives');
process.exit(ok ? 0 : 1);
