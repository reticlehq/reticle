import { describe, expect, it } from 'vitest';
import { ActionType, AnchorKind, type FlowStep } from '@reticlehq/core';
import { affectedSavedFlows, flowSources } from './flow-sources.js';

function componentStep(file: string, sub?: FlowStep[]): FlowStep {
  return {
    action: ActionType.CLICK,
    anchor: { kind: AnchorKind.COMPONENT, source: { file, line: 1 } },
    ...(sub === undefined ? {} : { steps: sub }),
  } as FlowStep;
}

function testidStep(): FlowStep {
  return {
    action: ActionType.CLICK,
    anchor: { kind: AnchorKind.TESTID, value: 'cta' },
  } as FlowStep;
}

describe('flowSources', () => {
  it('collects unique source files from component anchors, recursing into sub-steps', () => {
    const steps = [
      componentStep('src/Checkout.tsx', [componentStep('src/cart.ts')]),
      componentStep('src/Checkout.tsx'), // dup file
      testidStep(), // no source
    ];
    expect(flowSources(steps).sort()).toEqual(['src/Checkout.tsx', 'src/cart.ts']);
  });

  it('yields an empty manifest for a flow with only testid anchors', () => {
    expect(flowSources([testidStep()])).toEqual([]);
  });
});

describe('affectedSavedFlows', () => {
  it('selects a flow when a changed file is in its derived manifest', () => {
    const flows = [
      { name: 'checkout', steps: [componentStep('src/Checkout.tsx')] },
      { name: 'login', steps: [componentStep('src/Login.tsx')] },
    ];
    expect(affectedSavedFlows(flows, ['src/Checkout.tsx']).affected).toEqual(['checkout']);
  });

  it('treats a testid-only flow (empty manifest) as always affected', () => {
    const flows = [{ name: 'legacy', steps: [testidStep()] }];
    const result = affectedSavedFlows(flows, ['src/whatever.ts']);
    expect(result.affected).toEqual(['legacy']);
    expect(result.unknownProvenance).toEqual(['legacy']);
  });
});
