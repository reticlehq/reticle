/**
 * A recorded click on a nameless list item keeps the item's own words on its component anchor, and
 * replay looks the item up by them. Recorded on a phone input: the country item's anchor was
 * component + source line, the reference implementation's layout, so a correct fix that moved the
 * line could not be graded at all.
 */
import { describe, expect, it } from 'vitest';
import { ActionType, AnchorKind, FlowFileSchema, FLOW_FILE_VERSION } from '@reticlehq/core';
import { compileActStep, compileSequenceStep } from './replay.js';
import { recordedStepToFlowStep } from './flows.js';
import { componentQueryArgs } from './flow-anchor.js';

const SOURCE = { file: '../src/PhoneInput/PhoneInput.tsx', line: 182, column: 14 };
const GERMANY = {
  component: 'PhoneInput',
  source: SOURCE,
  role: 'presentation',
  ownText: '(+49) Germany (Deutschland)',
  componentNth: 77,
  componentOf: 233,
};

describe('a recorded click on a nameless element with its own words', () => {
  it('keeps the words on the component anchor', () => {
    const step = recordedStepToFlowStep(
      compileActStep({ ref: 'e7', action: ActionType.CLICK, args: {} }, GERMANY),
    );
    expect(step.anchor).toMatchObject({
      kind: AnchorKind.COMPONENT,
      text: '(+49) Germany (Deutschland)',
    });
  });

  it('keeps them on a sub-step of a sequence', () => {
    const step = recordedStepToFlowStep(
      compileSequenceStep(
        { steps: [{ ref: 'e7', action: ActionType.CLICK, args: {} }] },
        { steps: [GERMANY] },
      ),
    );
    expect((step.steps ?? [])[0]?.anchor).toMatchObject({
      kind: AnchorKind.COMPONENT,
      text: '(+49) Germany (Deutschland)',
    });
  });

  it('sends them with the replay query', () => {
    const step = recordedStepToFlowStep(
      compileActStep({ ref: 'e7', action: ActionType.CLICK, args: {} }, GERMANY),
    );
    if (step.anchor.kind !== AnchorKind.COMPONENT) {
      throw new Error('expected a component anchor');
    }
    expect(componentQueryArgs(step.anchor)).toMatchObject({ text: '(+49) Germany (Deutschland)' });
  });

  it('is a valid flow file once saved', () => {
    const step = recordedStepToFlowStep(
      compileActStep({ ref: 'e7', action: ActionType.CLICK, args: {} }, GERMANY),
    );
    const parsed = FlowFileSchema.safeParse({
      version: FLOW_FILE_VERSION,
      name: 'pick-germany',
      createdAt: 0,
      steps: [step],
    });
    expect(parsed.success).toBe(true);
  });
});
