import { describe, expect, it } from 'vitest';
import { Verified, VerifiedReason } from '@reticlehq/core';
import { gradeSequence, type StepExpectation } from './sequence-grade.js';

const held = (): StepExpectation => ({ declared: true, held: true });
const missed = (observed: string): StepExpectation => ({ declared: true, held: false, observed });
const silent = (): StepExpectation => ({ declared: false });
const quiet = (): StepExpectation => ({ declared: false, settled: true });

describe('grading a plan by what it declared', () => {
  it('is unknown when no step declared anything — a plan that asserts nothing proves nothing', () => {
    // No step reported a settled window, so nothing says the whole window was seen: `unknown`.
    const grade = gradeSequence([silent(), silent(), silent()]);
    expect(grade.verified).toBe(Verified.UNKNOWN);
    expect(grade.declared).toBe(0);
    expect(grade.because).toMatch(/declared nothing/i);
  });

  it('is no-fault when no step declared anything and every step settled with nothing flagged', () => {
    // The rule a single act_and_wait follows (engine/src/evidence/verified.ts): nothing declared
    // over a settled window is `no-fault`, not `unknown`. A plan graded `unknown` here told the
    // agent to look again with better coverage, when the fix is to declare a consequence.
    const grade = gradeSequence([quiet(), quiet()]);
    expect(grade.verified).toBe(Verified.NO_FAULT);
    expect(grade.reason).toBe(VerifiedReason.NOTHING_DECLARED);
    expect(grade.because).toMatch(/declared nothing/i);
  });

  it.each([
    ['a step did not settle', () => gradeSequence([quiet(), { declared: false, settled: false }])],
    [
      'a step saw an absence-derived finding',
      () => gradeSequence([quiet(), { ...quiet(), doubted: ['request-never-settled'] }]),
    ],
    [
      'the capture lost events',
      () => gradeSequence([quiet()], { planned: 1, dispatched: true, captureLost: true }),
    ],
  ])('stays unknown when %s', (_label, grade) => {
    expect(grade().verified).toBe(Verified.UNKNOWN);
    expect(grade().reason).toBe(VerifiedReason.NOTHING_DECLARED);
  });

  it('is yes when every declared consequence held', () => {
    const grade = gradeSequence([held(), held()]);
    expect(grade.verified).toBe(Verified.YES);
    expect(grade.declared).toBe(2);
  });

  it('is no when any declared consequence did not hold', () => {
    const grade = gradeSequence([held(), missed('no signal; route unchanged'), silent()]);
    expect(grade.verified).toBe(Verified.NO);
  });

  it('never hides how much of the plan proved nothing', () => {
    // 63 driven and 47 declared is not "75% verified" — it is verified for 47 and silent about 16,
    // and the answer has to say so rather than average it away.
    const grade = gradeSequence([silent(), silent(), silent(), held()]);
    expect(grade.verified).toBe(Verified.YES);
    expect(grade.declared).toBe(1);
    expect(grade.total).toBe(4);
    expect(grade.because).toContain('1 of 4');
  });

  it('reports a miss before coverage — a red is not softened by how much was declared', () => {
    const grade = gradeSequence([missed('nothing moved'), silent()]);
    expect(grade.verified).toBe(Verified.NO);
    expect(grade.because).toMatch(/did not hold/i);
  });

  it('grades an empty plan unknown rather than vacuously true', () => {
    expect(gradeSequence([]).verified).toBe(Verified.UNKNOWN);
  });

  /**
   * The headline counted the steps it REACHED while `coverage` counted the plan, and they disagreed
   * in the same payload.
   *
   * MEASURED on a real install: a two-step sequence whose first step was refused before dispatch
   * answered `"all 1 step(s) declared nothing, so the app was driven but not verified"` beside
   * `coverage: { declared: 0, total: 2 }`. Two numbers for one plan, and "the app was driven" about
   * a call where `dispatched` was `false` in the same object.
   */
  it('counts the plan, not the steps it got to', () => {
    const grade = gradeSequence([silent()], { planned: 2, dispatched: false });
    expect(grade.total).toBe(2);
    expect(grade.because).toContain('2 step(s)');
  });

  it('does not claim the app was driven when nothing dispatched', () => {
    const grade = gradeSequence([silent()], { planned: 2, dispatched: false });
    expect(grade.because).not.toContain('was driven');
    expect(grade.because).toContain('nothing was dispatched');
  });
});

/*
 * A journey graded on a lighter bar than one action. A plan whose only declared step was the FIRST
 * answered yes while the end of the journey was never checked, and a step whose channels disagreed
 * (the UI advanced while its write failed) still counted as held — both are verdicts act_and_wait
 * would not have given.
 */
describe('a journey is proved at its end, and a contradiction is a failure', () => {
  it('is unknown when the last step, where the journey ends, declared nothing', () => {
    const grade = gradeSequence([held(), silent(), silent()]);
    expect(grade.verified).toBe(Verified.UNKNOWN);
    expect(grade.because).toMatch(/last step/i);
  });

  it('is no when a step held while its channels disagreed', () => {
    const grade = gradeSequence([
      { declared: true, held: true, contradicted: ['ui-advanced-request-failed'] },
      held(),
    ]);
    expect(grade.verified).toBe(Verified.NO);
    expect(grade.because).toContain('ui-advanced-request-failed');
  });

  it('is no when a step could not be performed, declared or not', () => {
    const grade = gradeSequence([held(), { declared: false, held: false, observed: 'no ref' }], {
      planned: 3,
      dispatched: true,
    });
    expect(grade.verified).toBe(Verified.NO);
  });

  it('is unknown, not no, when a step`s consequence could not be read (the page went away)', () => {
    const grade = gradeSequence([
      held(),
      { declared: true, held: false, undecided: 'session disconnected (the page left)' },
    ]);
    expect(grade.verified).toBe(Verified.UNKNOWN);
    expect(grade.because).toContain('session disconnected');
  });

  it('still says no when another step really missed', () => {
    const grade = gradeSequence([
      missed('nothing'),
      { declared: true, held: false, undecided: 'the page left' },
    ]);
    expect(grade.verified).toBe(Verified.NO);
  });

  it('is unknown when fewer steps ran than were planned', () => {
    const grade = gradeSequence([held()], { planned: 3, dispatched: true });
    expect(grade.verified).toBe(Verified.UNKNOWN);
    expect(grade.because).toContain('1 of 3');
  });
});

/*
 * A re-drive: a step whose click left for an external page was graded "no" with "session
 * disconnected" observed, and a step whose target was missing answered "no" beside "Nothing was
 * acted on and no verdict is possible". Neither saw the app fail: both are undecided.
 */
describe('a step that could not be judged', () => {
  it('leaves the plan undecided, saying why', () => {
    const grade = gradeSequence([
      { declared: true, held: true },
      { declared: true, held: false, undecided: 'the page left the app (session disconnected)' },
    ]);
    expect(grade.verified).toBe(Verified.UNKNOWN);
    expect(grade.because).toContain('session disconnected');
  });

  it('does not hide a step that did fail', () => {
    const grade = gradeSequence([
      { declared: true, held: false, observed: 'no POST' },
      { declared: true, held: false, undecided: 'target matched no element' },
    ]);
    expect(grade.verified).toBe(Verified.NO);
  });

  // #2204: the sentence said "a step", so the agent did not know which step to change.
  it('names the step by its number and its action', () => {
    const grade = gradeSequence([
      { action: 'fill', declared: true, held: true },
      { action: 'click', declared: true, held: false, undecided: 'the page did not answer' },
      { action: 'click', declared: true, held: true },
    ]);
    expect(grade.reason).toBe(VerifiedReason.INCONCLUSIVE);
    expect(grade.because).toBe('step 2 (click) could not be judged: the page did not answer');
  });

  it('names the step by its number alone when the step has no action', () => {
    const grade = gradeSequence([{ declared: true, held: false, undecided: 'tab hidden' }]);
    expect(grade.because).toBe('step 1 could not be judged: tab hidden');
  });

  it('names the first step that could not be judged', () => {
    const grade = gradeSequence([
      { action: 'fill', declared: true, held: false, undecided: 'target matched no element' },
      { action: 'click', declared: true, held: false, undecided: 'tab hidden' },
    ]);
    expect(grade.because).toContain('step 1 (fill)');
    expect(grade.because).not.toContain('step 2');
  });
});

/*
 * `reticle_act { steps }` reported `verified: unknown` with no reason: the grade carried only a
 * sentence, so telemetry recorded every undecided sequence with no reason and nobody could count
 * why. Each grade names its clause from core's VerifiedReason, as a single action's verdict does.
 */
describe('gradeSequence names its reason', () => {
  it.each([
    [
      'a miss',
      () => gradeSequence([held(), missed('nothing moved')]),
      VerifiedReason.ASSERTION_FAILED,
    ],
    [
      'a contradiction',
      () => gradeSequence([{ ...held(), contradicted: ['net'] }]),
      VerifiedReason.CONTRADICTED,
    ],
    [
      'an undecided step',
      () => gradeSequence([{ declared: true, undecided: 'tab hidden' }]),
      VerifiedReason.INCONCLUSIVE,
    ],
    [
      'nothing declared',
      () => gradeSequence([silent(), silent()]),
      VerifiedReason.NOTHING_DECLARED,
    ],
    [
      'a journey cut short',
      () => gradeSequence([held()], { planned: 3, dispatched: true }),
      VerifiedReason.EVIDENCE_INCOMPLETE,
    ],
    [
      'an undeclared end',
      () => gradeSequence([held(), silent()]),
      VerifiedReason.EVIDENCE_INCOMPLETE,
    ],
    ['every consequence held', () => gradeSequence([held(), held()]), VerifiedReason.PROVED],
  ])('%s', (_label, grade, reason) => {
    expect(grade().reason).toBe(reason);
  });
});
