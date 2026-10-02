/**
 * A replay that stopped early must SAY it stopped early.
 *
 * `replayFlow` breaks out of its loop on the first failing step — deliberately, and correctly: once
 * a step's consequence did not hold, every later step would run against a state the flow never
 * described. But nothing in the result envelope says so. A two-step flow whose first step's `expect`
 * failed comes back as `steps: [oneResult]`, and a caller who does not already know the halt rule
 * sees a step that simply is not there.
 *
 * That is not hypothetical. It was reported as "replay silently skips a second destructive step":
 * step 1 never dispatched, no request fired, and the same click driven by hand worked. All three
 * observations were correct, and the conclusion — that a destructive-action gate was being swallowed
 * mid-replay — was wrong. The gate was never involved. Step 0's expectation failed and the run
 * stopped, which is the documented behaviour, invisible in the output.
 *
 * The cost of that invisibility was a filed defect, an investigation, and very nearly a fix to the
 * destructive-action path that nothing needed. One optional field ends it.
 */

import { describe, expect, it } from 'vitest';
import { haltedFrom } from './recording/replay-halt.js';
import { FLOW_TOOLS } from './flow-tools.js';
import { ReticleTool } from '@reticlehq/core';

const okStep = (step: number) => ({ step, tool: 't', anchor: 'a', ok: true });
const failedStep = (step: number) => ({ step, tool: 't', anchor: 'a', ok: false });

describe('haltedFrom', () => {
  it('reports the step it stopped at and how many were never attempted', () => {
    expect(haltedFrom([okStep(0), failedStep(1)], 4)).toEqual({ atStep: 1, notAttempted: 2 });
  });

  it('says nothing when every step ran', () => {
    // The common case must stay token-flat: a clean replay carries no extra field at all.
    expect(haltedFrom([okStep(0), okStep(1)], 2)).toBeUndefined();
  });

  it('says nothing when the LAST step failed — nothing was skipped', () => {
    // A failure on the final step is not a halt: there was nothing left to attempt, and reporting
    // `notAttempted: 0` would invite a reader to look for steps that do not exist.
    expect(haltedFrom([okStep(0), failedStep(1)], 2)).toBeUndefined();
  });

  it('counts from the flow’s own step total, not from the results array', () => {
    // The results array is the thing that is SHORT — deriving the total from it would always say
    // zero were skipped, which is the bug restated as its own fix.
    expect(haltedFrom([failedStep(0)], 5)).toEqual({ atStep: 0, notAttempted: 4 });
  });

  it('is undefined for an empty replay rather than claiming a halt at step zero', () => {
    expect(haltedFrom([], 3)).toBeUndefined();
  });
});

/**
 * The field has to be declared in TWO places or it arrives as nothing.
 *
 * `flow-tools.ts` says it in a comment right above `unverifiable`: "Declared here or a validating
 * profile strips it — the same way `name` was stripped once. A field the handler sets and the schema
 * omits arrives as nothing, silently." This asserts the pair, because the failure is invisible.
 */
describe('halted is declared on the tool surface, not only set by the handler', () => {
  it('is in reticle_flow_replay’s outputSchema', () => {
    const replay = FLOW_TOOLS.find((t) => t.name === ReticleTool.FLOW_REPLAY);
    expect(replay?.outputSchema?.['halted']).toBeDefined();
  });

  it('and the description tells the reader what a short steps array means', () => {
    const replay = FLOW_TOOLS.find((t) => t.name === ReticleTool.FLOW_REPLAY);
    expect(replay?.description).toContain('halted');
  });
});
