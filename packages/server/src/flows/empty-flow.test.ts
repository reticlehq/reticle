/**
 * A flow with no steps saved, reported success, and left a file that can never pass.
 *
 * Reported from a sweep:
 *
 *   flow_save   -> { stepCount: 0, grade: "assertion-free" }   with NO error
 *   flow_list   -> 1 flow
 *   flow_verify -> unverifiable
 *
 * The agent believes it saved a regression test. It saved nothing, and the file it wrote will report
 * `unverifiable` forever — so the suite carries a permanent entry that can never go green or red.
 *
 * Zero steps is not a degraded flow, it is the absence of one, and the honest answer is a refusal
 * that says what to check. It matters most on exactly the stacks where the recorder is known to
 * capture nothing (a separate defect), because there the empty save is the ONLY signal the agent
 * would get that something went wrong.
 */

import { describe, expect, it } from 'vitest';
import { emptyFlowRefusal } from './empty-flow.js';

describe('saving a flow with no steps', () => {
  it('is refused, with the likely cause named', () => {
    const refusal = emptyFlowRefusal(0, 'checkout');
    expect(refusal).toBeDefined();
    expect(refusal?.error).toContain('no steps');
    // The agent needs to know WHY a recording can be empty, or it just retries the same save.
    expect(refusal?.recovery).toContain('reticle_record');
  });

  it('names the flow, so the message is about the thing that failed', () => {
    expect(emptyFlowRefusal(0, 'checkout')?.error).toContain('checkout');
  });

  it('a flow with steps is not refused', () => {
    expect(emptyFlowRefusal(1, 'checkout')).toBeUndefined();
    expect(emptyFlowRefusal(12, 'checkout')).toBeUndefined();
  });
});
