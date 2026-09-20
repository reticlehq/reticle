import { describe, expect, it } from 'vitest';
import { Verified } from '@reticlehq/core';
import { gradeSequence, type StepExpectation } from './sequence-grade.js';

const held = (): StepExpectation => ({ declared: true, held: true });
const missed = (observed: string): StepExpectation => ({ declared: true, held: false, observed });
const silent = (): StepExpectation => ({ declared: false });

describe('grading a plan by what it declared', () => {
  it('is unknown when no step declared anything — a plan that asserts nothing proves nothing', () => {
    /*
     * `unknown`, deliberately, and NOT `no-fault` -- which this comment used to claim it was "the
     * same rule" as, while asserting the opposite enum. Two words for one state is how an agent
     * ends up taking the opposite next step, so the difference is worth stating.
     *
     * The engine emits `no-fault` for "nothing was declared" ONLY over a settled window
     * (`engine/src/evidence/verified.ts`): no-fault claims the whole window was observed, and a
     * call that returned while the app was still moving has not earned that claim. This path
     * tracks no settledness at all -- `act-sequence-tool.ts` never asks for it and no step result
     * carries it -- so `no-fault` here would be an assertion about evidence nobody collected.
     * `unknown` is the conservative word and the honest one.
     *
     * The agent is not left guessing either way: `because` names the exact next move, which is to
     * give each step an `expect`. Upgrading this to `no-fault` means plumbing `settled` through
     * `SequencePlan` from the act results, and it is not worth doing until something reads the
     * difference.
     */
    const grade = gradeSequence([silent(), silent(), silent()]);
    expect(grade.verified).toBe(Verified.UNKNOWN);
    expect(grade.declared).toBe(0);
    expect(grade.because).toMatch(/declared nothing/i);
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
    const grade = gradeSequence([held(), silent(), silent(), silent()]);
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
