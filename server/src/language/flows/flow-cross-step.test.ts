import { describe, expect, it } from 'vitest';
import {
  AnchorKind,
  ContradictionKind,
  ReticleTool,
  type Contradiction,
  type FlowStep,
  type FlowStepResult,
} from '@reticlehq/core';
import { crossStepOnly, declaredIn, stepContradictions } from './flow-cross-step.js';

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

describe('what the whole-span pass is told the flow expected', () => {
  it('collects every declared consequence, sub-steps included', () => {
    const refused = { kind: 'net', method: 'POST', status: 402 } as const;
    const shown = { kind: 'text', contains: 'Limit reached' } as const;
    const anchor = { kind: AnchorKind.TESTID, value: 'generate' } as const;
    const steps: FlowStep[] = [
      { tool: ReticleTool.ACT, anchor, args: {} },
      {
        tool: ReticleTool.ACT_SEQUENCE,
        anchor,
        expect: shown,
        steps: [{ tool: ReticleTool.ACT, anchor, args: {}, expect: refused }],
      },
    ];
    expect(declaredIn(steps)).toEqual([shown, refused]);
  });
});

/*
 * A flow that clicks Pause and then Resume sends the same POST to a toggle endpoint once per step.
 * The whole-span pass judged the replay as ONE action, so it read the two as `duplicate-request ×2`
 * and the flow graded unknown on a working toggle (#2013). "One user action wrote twice" is only a
 * claim about one step's window, and each step already checks its own.
 */
describe('a write repeated across steps', () => {
  const twice = (kind: Contradiction['kind']): Contradiction => ({
    kind,
    claim: 'one user action was performed',
    counter: 'the same write fired 2 times',
    detail: 'POST /api/links/abc/pause ×2',
  });

  it('is not a duplicate request in the whole-span pass', () => {
    expect(crossStepOnly([twice(ContradictionKind.DUPLICATE_REQUEST)], [step(0), step(1)])).toEqual(
      [],
    );
  });

  it('is not an unrelated duplicate request either', () => {
    expect(
      crossStepOnly([twice(ContradictionKind.DUPLICATE_REQUEST_UNRELATED)], [step(0), step(1)]),
    ).toEqual([]);
  });

  it('still keeps every other whole-span finding', () => {
    expect(crossStepOnly([twice(ContradictionKind.DUPLICATE_REQUEST), orphan], [step(0)])).toEqual([
      orphan,
    ]);
  });
});

/*
 * A step with no expectation returned before its request was sent; the request started inside the
 * NEXT step's window and finished after that window closed. The next step read it as
 * `request-never-settled` and graded unknown on a working sort (f-sort). "Never" can only be judged
 * when the replay is over, so a step defers it and the whole-span pass decides it.
 */
describe('a request still running when a step ends', () => {
  const inFlight: Contradiction = {
    kind: ContradictionKind.REQUEST_NEVER_SETTLED,
    claim: 'the UI moved forward and the action reported done',
    counter: '1 request(s) were still in flight',
    detail: 'GET /api/links?sort=-views',
  };

  it('is not decided by the step window', () => {
    expect(stepContradictions([inFlight, failed])).toEqual([failed]);
  });

  it('is still reported by the whole-span pass when it never came back', () => {
    expect(crossStepOnly([inFlight], [step(0, []), step(1, [])])).toEqual([inFlight]);
  });
});
