// Honesty / false-green benchmark. Runs each scenario through BOTH versions and scores false-green rate.
//
//  - WITH the honesty layer: the REAL composition from the built server dist (buildHonestyBlock over the same
//    inputs act_and_wait derives — coverage from BLIND_SPOT events, truncation from TRUNCATED events,
//    grade from the asserted consequence).
//  - WITHOUT it: no honesty block existed. A consumer of a bare green can only assume the best: full coverage,
//    clean integrity, strongest grade. So the pre-honesty baseline "discloses" nothing.
//
// A verdict is a FALSE GREEN when reality carried a caveat the verdict did not disclose. The metric is
// the false-green rate over scenarios that HAD a caveat (the control has none — it checks over-flagging).
//
// Run: node bench/honesty/run-honesty.mjs   (deterministic, no agent/API cost)

import { EventType } from '@reticlehq/core';
import { buildHonestyBlock, meetsHonestyBar } from '../../packages/server/dist/honesty/honesty.js';
import {
  blindSpotsFromEvents,
  buildCoverageStatement,
} from '../../packages/server/dist/honesty/blind-spots.js';
import { HONESTY_SCENARIOS } from './scenarios.mjs';

/** Derive the honesty inputs act_and_wait would compute from a window + the asserted grade. */
function v22Honesty(scenario) {
  const coverage = buildCoverageStatement(blindSpotsFromEvents(scenario.events));
  const truncated = scenario.events.some((e) => e.type === EventType.TRUNCATED);
  return buildHonestyBlock({
    grade: scenario.grade,
    coveragePartial: coverage.coverage === 'partial',
    truncated,
    ...(coverage.note === undefined ? {} : { blindSpots: [coverage.note] }),
  });
}

/** What a the pre-honesty baseline green actually discloses: nothing. A consumer must assume the most trustworthy reading. */
const V21_DISCLOSURE = {
  coverageDisclosedPartial: false,
  integrityDisclosedDirty: false,
  gradeDisclosed: false, // no grade field at all → a presence-green is indistinguishable from a signal-green
};

/** Did this verdict disclose every caveat reality carried? Returns the list of HIDDEN caveats. */
function hiddenCaveats(reality, disclosure) {
  const hidden = [];
  if (reality.coverageGap && !disclosure.coverageDisclosedPartial) hidden.push('coverage-gap');
  if (reality.truncated && !disclosure.integrityDisclosedDirty) hidden.push('truncation');
  if (reality.weakGrade && !disclosure.gradeDisclosed) hidden.push('weak-grade');
  return hidden;
}

function scoreV22(scenario) {
  const h = v22Honesty(scenario);
  return hiddenCaveats(scenario.reality, {
    coverageDisclosedPartial: h.coverage.partial,
    integrityDisclosedDirty: !h.integrity.clean,
    // grade is disclosed iff the block carries a non-strong grade the consumer can gate on.
    gradeDisclosed: scenario.reality.weakGrade ? h.grade === scenario.grade : true,
  });
}

function run() {
  const rows = [];
  for (const s of HONESTY_SCENARIOS) {
    const hadCaveat = s.reality.coverageGap || s.reality.truncated || s.reality.weakGrade;
    const v21Hidden = hiddenCaveats(s.reality, V21_DISCLOSURE);
    const v22Hidden = scoreV22(s);
    rows.push({
      name: s.name,
      hadCaveat,
      v21FalseGreen: v21Hidden.length > 0,
      v22FalseGreen: v22Hidden.length > 0,
      v21Hidden,
      v22Hidden,
    });
  }
  const withCaveat = rows.filter((r) => r.hadCaveat);
  const rate = (rs, key) =>
    rs.length === 0 ? 0 : Math.round((rs.filter((r) => r[key]).length / rs.length) * 100);

  // Gate demo: a CI harness requiring "grade >= net AND integrity clean". the pre-honesty baseline can't gate (no block).
  const gateSample = HONESTY_SCENARIOS.find((s) => s.name === 'presence-only-green');
  const gate = meetsHonestyBar(v22Honesty(gateSample), {
    minGrade: 'net',
    requireIntegrityClean: true,
  });

  return {
    rows,
    control: rows.find((r) => r.name.includes('control')),
    v21FalseGreenRate: rate(withCaveat, 'v21FalseGreen'),
    v22FalseGreenRate: rate(withCaveat, 'v22FalseGreen'),
    caveatScenarios: withCaveat.length,
    gate,
  };
}

const result = run();
console.log('\n=== Honesty / false-green benchmark ===\n');
for (const r of result.rows) {
  const mark = (fg) => (fg ? '✗ false-green' : '✓ honest');
  console.log(
    `${r.name}\n   the pre-honesty baseline: ${mark(r.v21FalseGreen)}${r.v21Hidden.length ? ` (hides ${r.v21Hidden.join(', ')})` : ''}` +
      `\n   the honesty layer: ${mark(r.v22FalseGreen)}${r.v22Hidden.length ? ` (hides ${r.v22Hidden.join(', ')})` : ''}`,
  );
}
console.log(
  `\nfalse-green rate over ${result.caveatScenarios} caveat scenarios:  the pre-honesty baseline = ${result.v21FalseGreenRate}%   the honesty layer = ${result.v22FalseGreenRate}%`,
);
console.log(
  `over-flagging check (control): ${result.control.v22FalseGreen ? 'FAIL — flagged a clean green' : 'PASS — clean green stays clean'}`,
);
console.log(
  `CI gate (grade>=net AND integrity clean) on presence-only green: the honesty layer ${result.gate.ok ? 'ALLOWS (bug)' : 'REJECTS'} → ${result.gate.reasons.join('; ')}; the pre-honesty baseline cannot gate (no honesty block)\n`,
);

// Non-zero exit if the honesty layer ever produces a false green or over-flags the control — makes this CI-gateable.
const broken = result.v22FalseGreenRate > 0 || result.control.v22FalseGreen;
process.exit(broken ? 1 : 0);
