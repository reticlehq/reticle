import { describe, expect, it } from 'vitest';
import { ContradictionKind, type Contradiction, type FlowStepResult } from '@reticlehq/core';
import { crossStepOnly } from './flow-replay-run.js';

/**
 * The contradictions no per-step window can see, by construction.
 *
 * A step's window closes when the step ends. A request fired at step 2 that never settles until
 * step 5 — or never at all — falls outside every one of those windows: step 2's closed before the
 * answer came, and step 5 never saw it start. The detectors are run again over the WHOLE replay
 * span to catch that, which re-finds everything the steps already reported, so what makes this
 * useful is the subtraction.
 */

const failed: Contradiction = {
  kind: ContradictionKind.UI_ADVANCED_REQUEST_FAILED,
  claim: 'the screen advanced',
  counter: 'POST /api/orders returned 500',
  detail: 'POST /api/orders 500',
};
const orphan: Contradiction = {
  kind: ContradictionKind.UI_ADVANCED_REQUEST_FAILED,
  claim: 'the screen advanced',
  counter: 'PATCH /api/cart never settled',
  detail: 'PATCH /api/cart pending',
};

function step(step: number, contradictions?: Contradiction[]): FlowStepResult {
  return {
    step,
    ok: true,
    ...(contradictions === undefined ? {} : { contradictions }),
  } as FlowStepResult;
}

describe('what the whole-span pass adds over the per-step ones', () => {
  it('keeps a contradiction no step reported', () => {
    expect(crossStepOnly([failed, orphan], [step(0, [failed])])).toEqual([orphan]);
  });

  it('drops every one a step already carries, so the same finding is not reported twice', () => {
    expect(crossStepOnly([failed], [step(0, [failed])])).toEqual([]);
  });

  it('matches on kind AND detail, so two failures of the same kind are not conflated', () => {
    const other = { ...failed, detail: 'POST /api/login 500' };
    expect(crossStepOnly([failed, other], [step(0, [failed])])).toEqual([other]);
  });

  it('keeps everything when no step reported anything', () => {
    expect(crossStepOnly([failed], [step(0), step(1)])).toEqual([failed]);
  });

  it('is empty when the whole-span pass found nothing', () => {
    expect(crossStepOnly([], [step(0, [failed])])).toEqual([]);
  });
});
