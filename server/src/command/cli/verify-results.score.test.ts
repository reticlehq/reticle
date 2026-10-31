/**
 * A score of how far each journey got, not only whether it passed.
 *
 * A pass/fail verdict per journey says nothing about a change that does nine of ten things right.
 * The score counts steps: passed, failed, and unknown. Unknown is every step that was never judged
 * (the replay stopped before it, or the journey could not run), and it stays in the total, so an
 * undecided step can never raise the score. Measured: a journey-pass fraction that left
 * `unknown` journeys out of the total scored two broken changes at 1.0.
 */
import { describe, expect, it } from 'vitest';
import { RunFlowStatus, VerdictStatus, type ReticleVerificationRun } from '@reticlehq/core';
import { RESULTS_SCHEMA_VERSION, verifyResults } from './verify-results.js';

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
    ] as unknown as Flow[];
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
    ] as unknown as Flow[];
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
    ] as unknown as Flow[];
    expect(verifyResults(run(flows)).score).toEqual({
      passed: 2,
      failed: 0,
      unknown: 0,
      total: 2,
      value: 1,
    });
  });
});

/*
 * A recorded journey is often ONE sequence step of many sub-steps (fill, fill, press Enter, check).
 * Counted as one step, it scored all or nothing, so a change that got 7 of 9 sub-steps right scored
 * the same as one that got none. A sequence counts its sub-steps.
 */
describe('a sequence step in the score', () => {
  it('counts the sub-steps it completed, the one that failed, and the ones it never reached', () => {
    const flows = [
      {
        name: 'a',
        status: RunFlowStatus.FAIL,
        steps: 1,
        durationMs: 1,
        stepResults: [
          { ...step(0, false, 'signal_not_observed'), subSteps: { passed: 3, total: 6 } },
        ],
      },
    ] as unknown as Flow[];
    const r = verifyResults(run(flows), false, new Map([['a', 6]]));
    expect(r.results[0]?.steps).toEqual({ passed: 3, failed: 1, unknown: 2 });
  });

  it('counts every sub-step of a passed sequence as passed', () => {
    const flows = [
      {
        name: 'a',
        status: RunFlowStatus.PASS,
        steps: 1,
        durationMs: 1,
        stepResults: [{ ...step(0, true), subSteps: { passed: 4, total: 4 } }],
      },
    ] as unknown as Flow[];
    expect(verifyResults(run(flows), false, new Map([['a', 4]])).score).toEqual({
      passed: 4,
      failed: 0,
      unknown: 0,
      total: 4,
      value: 1,
    });
  });
});

/*
 * Gated partial credit. Under `--sweep` the replay goes on after a failed step, so later steps get a
 * verdict too. A step that passes AFTER an earlier step failed is not progress on the journey: a page
 * can fail "save" and still show the next screen. Counted as passed, those steps made a broken app
 * score higher than a stopped replay of the same app, and a score that pays a step without its
 * prerequisites is one a broken change can satisfy without the journey. They are reported apart, as
 * `swept`, and stay `unknown` in the score.
 */
describe('the score after a failed step', () => {
  const swept = [
    {
      name: 'a',
      status: RunFlowStatus.FAIL,
      steps: 4,
      durationMs: 1,
      stepResults: [
        step(0, true),
        step(1, false, 'signal_not_observed'),
        step(2, true),
        step(3, false, 'signal_not_observed'),
      ],
    },
  ] as unknown as Flow[];

  it('pays no step after the first failure, and reports those verdicts apart', () => {
    const r = verifyResults(run(swept), false, new Map([['a', 4]]));
    expect(r.results[0]?.steps).toEqual({
      passed: 1,
      failed: 1,
      unknown: 2,
      swept: { passed: 1, failed: 1 },
    });
    expect(r.score).toEqual({ passed: 1, failed: 1, unknown: 2, total: 4, value: 0.25 });
  });

  it('scores a swept replay the same as a stopped one', () => {
    const stopped = [
      { ...swept[0], stepResults: swept[0]?.stepResults?.slice(0, 2) },
    ] as unknown as Flow[];
    const plan = new Map([['a', 4]]);
    expect(verifyResults(run(swept), false, plan).score).toEqual(
      verifyResults(run(stopped), false, plan).score,
    );
  });
});

/*
 * The file says which shape it is. A CI step that parses it cannot tell the shape with `score` and
 * `steps` from the one before it, and an absent field looks the same as an old file.
 */
describe('the results file version', () => {
  it('names its schema version', () => {
    const r = verifyResults(run([]));
    expect(r.schemaVersion).toBe(RESULTS_SCHEMA_VERSION);
    expect(RESULTS_SCHEMA_VERSION).toBe(2);
  });
});
