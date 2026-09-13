import { describe, expect, it } from 'vitest';
import { Verified } from '@reticlehq/core';
import { gradeSequence, type StepExpectation } from './sequence-grade.js';

const held = (): StepExpectation => ({ declared: true, held: true });
const missed = (observed: string): StepExpectation => ({ declared: true, held: false, observed });
const silent = (): StepExpectation => ({ declared: false });

describe('grading a plan by what it declared', () => {
  it('is unknown when no step declared anything — a plan that asserts nothing proves nothing', () => {
    // The same rule `no-fault` states for a single action: driving is not verifying.
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
});
