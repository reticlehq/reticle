import { describe, expect, it } from 'vitest';
import { ReticleTool } from '@reticlehq/core';
import { compileSequenceStep } from './replay.js';
import { recordedStepToFlowStep } from './flows.js';

/**
 * A recorded sequence must keep what each of its steps declared.
 *
 * `reticle_act_sequence` now takes an `expect` per step, and a step's declared consequence is the
 * only thing that makes its replay prove anything. If the recorder drops it, the saved flow is
 * assertion-free — it replays green whether or not the feature works, which is the exact shape
 * `classifyFlowAssertions` grades and the exact reason 137 of 137 steps in this repo's own corpus
 * prove nothing today.
 *
 * The chain is three hops and every one of them has to carry it: the live call is compiled to a
 * RecordedStep, the RecordedStep is converted to a FlowStep, and the FlowStep is what replay runs.
 */

const RESULT = {
  count: 2,
  steps: [
    { ref: 'e1', testid: 'login-email', action: 'fill' },
    { ref: 'e2', testid: 'login-submit', action: 'click' },
  ],
};

const SEQUENCE_ARGS = {
  steps: [
    { ref: 'e1', action: 'fill', args: { value: 'a@b.com' } },
    { ref: 'e2', action: 'click', expect: { kind: 'signal', name: 'auth:ok' } },
  ],
};

describe('recording a sequence keeps each step`s declared consequence', () => {
  it('compiles the sub-step`s expect into the recorded step', () => {
    const recorded = compileSequenceStep(SEQUENCE_ARGS, RESULT);
    const subs = recorded.args['steps'] as Record<string, unknown>[];
    expect(subs).toHaveLength(2);
    expect(subs[0]?.['expect']).toBeUndefined();
    expect(subs[1]?.['expect']).toEqual({ signal: 'auth:ok' });
  });

  it('carries it through into the saved flow`s sub-steps', () => {
    const flowStep = recordedStepToFlowStep(compileSequenceStep(SEQUENCE_ARGS, RESULT));
    expect(flowStep?.tool).toBe(ReticleTool.ACT_SEQUENCE);
    expect(flowStep?.steps?.[1]?.expect).toEqual({ signal: 'auth:ok' });
  });

  it('drops a predicate replay could not enforce rather than recording a claim nothing checks', () => {
    // Same rule `captureAct` already applies to a single act: only kinds a replay actually CHECKS
    // survive. Recording an unenforced assertion grades the flow "asserted" while nothing verifies
    // it, which is a false green inside the feature built to prevent them.
    const withJunk = {
      steps: [{ ref: 'e2', action: 'click', expect: { kind: 'not-a-predicate' } }],
    };
    const subs = compileSequenceStep(withJunk, { count: 1, steps: [RESULT.steps[1]] }).args[
      'steps'
    ] as Record<string, unknown>[];
    expect(subs[0]?.['expect']).toBeUndefined();
  });
});
