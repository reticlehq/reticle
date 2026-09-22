import { describe, expect, it } from 'vitest';
import {
  Declaration,
  OVP_VERSION,
  RunOutcome,
  VerificationRunSchema,
  Verdict,
  outcomeOf,
  standingVerdicts,
} from 'open-verification';
import { buildRun } from './run.js';
import type { DriveOutcome } from './run.js';

const drive: DriveOutcome = {
  claim: {
    id: 'c1',
    statement: 'the build writes dist/index.js',
    declaredAt: Declaration.BEFORE_ACTION,
    assertions: [
      {
        id: 'a1',
        predicate: { kind: 'present', match: { channel: 'x-artifact' } },
        reads: 'a file was written',
        channels: ['x-artifact'],
      },
    ],
  },
  action: { id: 'act1', actor: 'agent', capability: 'build', at: 10 },
  receipt: {
    action: 'act1',
    dispatched: true,
    subject: { surface: 'x-cli', instance: 'tool@1#ws' },
    at: 11,
  },
  window: {
    id: 'w1',
    openedAt: 10,
    closedAt: 30,
    budgetMs: 5_000,
    closes: 'exit',
    closedBy: 'exit',
    subject: { surface: 'x-cli', instance: 'tool@1#ws' },
  },
  channels: [{ id: 'x-artifact', independence: 'independent', grade: 'consequence' }],
  evidence: [],
  coverage: { window: 'w1', observed: ['x-artifact'], blindSpots: [] },
  anomalies: [],
  adjudication: {
    verdict: Verdict.YES,
    grade: 'consequence',
    ground: 'proved',
    reasons: ['proved'],
  },
};

const run = (over: Partial<DriveOutcome> = {}) =>
  buildRun({ id: 'run-1', drives: [{ ...drive, ...over }], startedAt: 0, endedAt: 100 });

describe('the artifact a human and an agent share', () => {
  /**
   * It validates against the published schema, which is what makes it worth emitting at all.
   *
   * A report is something a reader has to trust the producer for. A `VerificationRun` is a
   * document anybody who has never heard of us can parse, re-check and compare, and the only
   * thing that makes that true is that it conforms.
   */
  it('is a document the specification recognises', () => {
    const parsed = VerificationRunSchema.safeParse(run());
    expect(parsed.success, JSON.stringify(parsed.error?.issues?.slice(0, 3))).toBe(true);
    expect(run().ovp).toBe(OVP_VERSION);
  });

  /**
   * The verdict carries the GRADE that bought it, so a cheap green cannot pass for a dear one.
   *
   * This is the property that separates the artifact from a pass/fail line: `yes` alone says
   * nothing about what paid for it, and the whole argument of this adapter is that some evidence
   * can pay and some cannot.
   */
  it('records what bought each yes', () => {
    const verdict = run().verdicts[0];
    expect(verdict?.verdict).toBe(Verdict.YES);
    expect(verdict?.grade).toBe('consequence');
  });

  /**
   * The outcome is COMPUTED by the reader, never asserted by the producer.
   *
   * A producer that writes its own summary can write one its verdicts do not support, which is
   * the single lie this document must not be able to tell. `outcomeOf` is what a consumer runs to
   * check us.
   */
  it('summarises to an outcome a consumer can recompute and disagree with', () => {
    expect(outcomeOf(run())).toBe(RunOutcome.PASS);
    expect(
      outcomeOf(
        run({
          adjudication: {
            verdict: Verdict.UNKNOWN,
            ground: 'no-independent-consequence',
            reasons: [],
          },
        }),
      ),
    ).toBe(RunOutcome.UNKNOWN);
  });

  /** A run of nothing but unknowns is NOT a pass, which is why those values survive into it. */
  it('does not let a window of unknowns read as success', () => {
    const unknowns = buildRun({
      id: 'r',
      startedAt: 0,
      endedAt: 1,
      drives: [
        {
          ...drive,
          adjudication: { verdict: Verdict.UNKNOWN, ground: 'coverage-impeached', reasons: [] },
        },
        {
          ...drive,
          adjudication: { verdict: Verdict.NO_FAULT, ground: 'nothing-declared', reasons: [] },
        },
      ],
    });
    expect(outcomeOf(unknowns)).toBe(RunOutcome.UNKNOWN);
  });

  it('carries the coverage each verdict was reached under, not just the verdict', () => {
    expect(run().coverage).toHaveLength(1);
    expect(run().coverage[0]?.window).toBe('w1');
  });

  it('leaves every verdict standing when nothing was superseded', () => {
    expect(standingVerdicts(run())).toHaveLength(1);
  });
});
