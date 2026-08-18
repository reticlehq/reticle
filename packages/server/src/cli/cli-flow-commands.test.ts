import { describe, expect, it } from 'vitest';
import type { Coverage } from '../flows/coverage.js';
import type { GateResult } from '../flows/gate.js';
import { buildGateOutcome } from './cli-flow-commands.js';

function dimension(total: number, covered: number) {
  return {
    total,
    covered,
    pct: 0 === total ? 100 : Math.round((covered / total) * 100),
    uncovered: [],
  };
}

function coverageOf(total: number, covered: number): Coverage {
  const flows = dimension(total, covered);
  const empty = dimension(0, 0);
  return { testids: empty, signals: empty, flows, overallPct: flows.pct };
}

const CLEAN_RESULT: GateResult = {
  pass: true,
  uncovered: [],
  quarantined: [],
  downgraded: [],
  deleted: [],
};

describe('buildGateOutcome', () => {
  it('a project with zero recorded flows does not pass, even though gateDecision and coverage are both vacuously green', () => {
    // This is the bug in #365: `affected` is empty (nothing to be affected by) and
    // `coverage.flows.pct` is vacuously 100 (no declared surface) — both correct on their own, but
    // together they used to report `pass: true` / `coverage.pct: 100` for a project that has never
    // recorded a single flow.
    const outcome = buildGateOutcome(CLEAN_RESULT, coverageOf(0, 0), true);
    expect(outcome.pass).toBe(false);
    expect(outcome.reason).toMatch(/no flows recorded/);
    expect(outcome.coverage).toEqual({ pct: 100, covered: 0, total: 0 });
  });

  it('a project with recorded flows and nothing affected still passes cleanly (no false reason)', () => {
    const outcome = buildGateOutcome(CLEAN_RESULT, coverageOf(3, 3), false);
    expect(outcome.pass).toBe(true);
    expect(outcome.reason).toBeUndefined();
  });

  it('a real uncovered flow still blocks, independently of the zero-flows check', () => {
    const result: GateResult = {
      pass: false,
      uncovered: ['checkout'],
      quarantined: [],
      downgraded: [],
      deleted: [],
    };
    const outcome = buildGateOutcome(result, coverageOf(2, 1), false);
    expect(outcome.pass).toBe(false);
    expect(outcome.uncovered).toEqual(['checkout']);
    expect(outcome.reason).toBeUndefined();
  });

  it('downgraded and deletedCoverage are still surfaced when present', () => {
    const result: GateResult = {
      pass: false,
      uncovered: [],
      quarantined: [],
      downgraded: [{ flow: 'checkout', steps: [1] }],
      deleted: ['billing'],
    };
    const outcome = buildGateOutcome(result, coverageOf(2, 2), false);
    expect(outcome.downgraded).toEqual([{ flow: 'checkout', steps: [1] }]);
    expect(outcome.deletedCoverage).toEqual(['billing']);
  });
});
