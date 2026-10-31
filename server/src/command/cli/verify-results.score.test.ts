/**
 * A score of how far each journey got, not only whether it passed.
 *
 * A pass/fail verdict per journey says nothing about a change that does nine of ten things right.
 * The score counts steps: passed, failed, and unknown. Unknown is every step that was never judged
 * (the replay stopped before it, or the journey could not run), and it stays in the total, so an
 * undecided step can never raise the score. Measured on a bench: a journey-pass fraction that left
 * `unknown` journeys out of the total scored two broken changes at 1.0.
 */
import { describe, expect, it } from 'vitest';
import { RunFlowStatus, VerdictStatus, type ReticleVerificationRun } from '@reticlehq/core';
import { verifyResults } from './verify-results.js';

type Flow = ReticleVerificationRun['flows'][number];

function run(flows: Flow[]): ReticleVerificationRun {
  return { flows, verdict: { status: VerdictStatus.FAIL } } as unknown as ReticleVerificationRun;
}

const step = (n: number, ok: boolean, drift?: string) => ({
  step: n,
  anchor: `s${String(n)}`,
  ok,
  ...(drift === undefined ? {} : { drift }),
});

describe('the score in verify results', () => {
  it('counts the steps a journey passed, failed, and never reached', () => {
    const flows = [
      {
        name: 'a',
        status: RunFlowStatus.FAIL,
        steps: 2,
        durationMs: 1,
        stepResults: [step(0, true), step(1, false, 'signal_not_observed')],
      },
    ] as Flow[];
    const r = verifyResults(run(flows), false, new Map([['a', 4]]));
    expect(r.results[0]?.steps).toEqual({ passed: 1, failed: 1, unknown: 2 });
    expect(r.score).toEqual({ passed: 1, failed: 1, unknown: 2, total: 4, value: 0.25 });
  });

  it('keeps a journey that could not run in the total, all unknown', () => {
    const flows = [
      {
        name: 'a',
        status: RunFlowStatus.PASS,
        steps: 2,
        durationMs: 1,
        stepResults: [step(0, true), step(1, true)],
      },
      { name: 'b', status: RunFlowStatus.SKIPPED, steps: 0, durationMs: 1 },
    ] as Flow[];
    const r = verifyResults(
      run(flows),
      false,
      new Map([
        ['a', 2],
        ['b', 3],
      ]),
    );
    expect(r.results[1]?.steps).toEqual({ passed: 0, failed: 0, unknown: 3 });
    expect(r.score).toEqual({ passed: 2, failed: 0, unknown: 3, total: 5, value: 0.4 });
  });

  it('uses the steps that ran when the flow file is not known', () => {
    const flows = [
      {
        name: 'a',
        status: RunFlowStatus.PASS,
        steps: 2,
        durationMs: 1,
        stepResults: [step(0, true), step(1, true)],
      },
    ] as Flow[];
    expect(verifyResults(run(flows)).score).toEqual({
      passed: 2,
      failed: 0,
      unknown: 0,
      total: 2,
      value: 1,
    });
  });
});
