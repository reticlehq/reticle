/**
 * Compare two suite runs bug-by-bug.
 *
 * A single run is an anecdote. What makes a benchmark citable is that it says the same thing twice —
 * and the failure mode worth catching is not "the totals moved" but "the totals matched while
 * different bugs flipped in opposite directions", which nets to zero and looks stable.
 *
 * Usage: node bench/pw-vs-reticle/compare-runs.mjs <a.json> <b.json>
 * Exits non-zero if any bug changed verdict, so it can gate.
 */
import { readFileSync } from 'node:fs';

const [, , pathA, pathB] = process.argv;
if (pathA === undefined || pathB === undefined) {
  console.error('usage: compare-runs.mjs <runA.json> <runB.json>');
  process.exit(2);
}

const load = (p) => {
  const { rows, agg } = JSON.parse(readFileSync(p, 'utf8'));
  const byKey = new Map();
  for (const r of rows) byKey.set(`${r.harness}|${r.bug}|${r.variant}`, r);
  return { byKey, agg };
};

const a = load(pathA);
const b = load(pathB);

const keys = [...new Set([...a.byKey.keys(), ...b.byKey.keys()])].sort();
const flipped = [];
const onlyIn = [];

for (const key of keys) {
  const ra = a.byKey.get(key);
  const rb = b.byKey.get(key);
  if (ra === undefined || rb === undefined) {
    onlyIn.push(`${key} — only in ${ra === undefined ? 'B' : 'A'}`);
    continue;
  }
  if (ra.caught !== rb.caught) {
    flipped.push({ key, from: ra.caught, to: rb.caught, noteA: ra.note, noteB: rb.note });
  }
}

console.log(`rows: A=${a.byKey.size} B=${b.byKey.size}`);
for (const harness of ['reticle-script', 'playwright-script']) {
  const ga = a.agg?.[harness];
  const gb = b.agg?.[harness];
  if (ga === undefined || gb === undefined) continue;
  console.log(
    `${harness.padEnd(18)} caught ${ga.caught}→${gb.caught}  ` +
      `ofExpected ${ga.caughtOfExpected}/${ga.expected}→${gb.caughtOfExpected}/${gb.expected}  ` +
      `falsePositives ${ga.falsePositives}→${gb.falsePositives}`,
  );
}

if (onlyIn.length > 0) {
  console.log(`\nrows present in only one run (${onlyIn.length}):`);
  for (const line of onlyIn.slice(0, 20)) console.log('  ', line);
}

console.log(`\nverdict flips: ${flipped.length}`);
for (const f of flipped) {
  console.log(`  ${f.key}: caught ${f.from} → ${f.to}`);
  console.log(`     A: ${String(f.noteA).slice(0, 90)}`);
  console.log(`     B: ${String(f.noteB).slice(0, 90)}`);
}

if (flipped.length === 0 && onlyIn.length === 0) {
  console.log('\nREPRODUCIBLE: every bug reached the same verdict in both runs.');
  process.exit(0);
}
// A flip is not necessarily a regression — the harness may have been fixed between runs — but it must
// be explained rather than averaged away.
console.log(
  '\nNOT byte-identical: each flip above needs an explanation before the numbers are quoted.',
);
process.exit(1);
