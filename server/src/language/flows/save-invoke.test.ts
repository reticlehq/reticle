import { describe, expect, it } from 'vitest';
import { recordedStepToFlowStep } from './flows.js';
import { INVOKE_TOOL } from './recording/tape/recordings.js';
import { FlowStepTool, FlowStepSchema } from '@reticlehq/core';

/**
 * An invocation has to SURVIVE being saved.
 *
 * The recorder can close a sub-flow boundary and the replayer can follow one, and between them sits
 * the conversion to the on-disk shape. If that drops `invoke`, the boundary is discarded at the last
 * possible moment: the file reads as a step that drives nothing, replay does nothing, and the
 * composite is green having run none of its sub-journeys. Every piece would be built and the feature
 * would still not exist.
 */

describe('saving an invocation step', () => {
  const recorded = {
    tool: INVOKE_TOOL,
    args: { flow: 'onboarding/signup' },
    stable: true,
    invoke: 'onboarding/signup',
  };

  it('keeps the name, and does not turn it into an action', () => {
    const step = recordedStepToFlowStep(recorded);
    expect(step.tool).toBe(FlowStepTool.INVOKE);
    expect(step.invoke).toBe('onboarding/signup');
    // An invocation drives nothing itself. An `action` here would make a replayer try to dispatch it.
    expect(step.action).toBeUndefined();
  });

  it('round-trips through the published step schema', () => {
    // The saved file is the contract. A field the schema strips is a field that does not exist.
    const parsed = FlowStepSchema.parse(recordedStepToFlowStep(recorded));
    expect(parsed.invoke).toBe('onboarding/signup');
  });

  it('leaves an ordinary action exactly as it was', () => {
    const act = recordedStepToFlowStep({
      tool: FlowStepTool.ACT,
      args: { action: 'click', by: 'testid', value: 'submit' },
      stable: true,
    });
    expect(act.invoke).toBeUndefined();
    expect(act.tool).toBe(FlowStepTool.ACT);
  });
});
