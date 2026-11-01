/**
 * A recorded click on a nameless control with no own words keeps the control's role on its
 * component anchor, and replay looks the control up by it. Recorded on a phone input: the country
 * toggle (`role="none"`) was anchored by component and source line only. On another correct layout
 * that line held the flag's SVG paths, and the replay could not grade the build.
 */
import { describe, expect, it } from 'vitest';
import { ActionType, AnchorKind, FlowFileSchema, FLOW_FILE_VERSION } from '@reticlehq/core';
import { compileActStep, compileSequenceStep } from './replay.js';
import { recordedStepToFlowStep } from './flows.js';
import { componentQueryArgs } from './flow-anchor.js';

const TOGGLE = {
  component: 'PhoneInput',
  source: { file: '../src/PhoneInput/PhoneInput.tsx', line: 123, column: 8 },
  role: 'none',
  componentNth: 1,
  componentOf: 2,
};

function saved() {
  return recordedStepToFlowStep(
    compileActStep({ ref: 'e7', action: ActionType.CLICK, args: {} }, TOGGLE),
  );
}

describe('a recorded click on a nameless control with no own words', () => {
  it('keeps the role on the component anchor', () => {
    expect(saved().anchor).toMatchObject({ kind: AnchorKind.COMPONENT, role: 'none', nth: 1 });
  });

  it('keeps it on a sub-step of a sequence', () => {
    const step = recordedStepToFlowStep(
      compileSequenceStep(
        { steps: [{ ref: 'e7', action: ActionType.CLICK, args: {} }] },
        { steps: [TOGGLE] },
      ),
    );
    expect((step.steps ?? [])[0]?.anchor).toMatchObject({
      kind: AnchorKind.COMPONENT,
      role: 'none',
    });
  });

  it('sends it with the replay query', () => {
    const { anchor } = saved();
    if (anchor.kind !== AnchorKind.COMPONENT) {
      throw new Error('expected a component anchor');
    }
    expect(componentQueryArgs(anchor)).toMatchObject({ role: 'none' });
  });

  it('is a valid flow file once saved', () => {
    const parsed = FlowFileSchema.safeParse({
      version: FLOW_FILE_VERSION,
      name: 'open-country-list',
      createdAt: 0,
      steps: [saved()],
    });
    expect(parsed.success).toBe(true);
  });
});
