import { describe, expect, it } from 'vitest';
import {
  ActionType,
  AnchorKind,
  FLOW_FILE_VERSION,
  HealStatus,
  ReticleTool,
  type FlowFile,
  type FlowStep,
} from '@reticlehq/core';
import { healPrecondition } from './heal-precondition.js';

/**
 * Healing a flow that asserts nothing is the self-healing false green, rebuilt as a feature.
 *
 * A heal re-points a drifted anchor at the nearest match. What stops that becoming a lie is the
 * consequence: a locator healed to the WRONG element cannot fake a signal, a request, or a store
 * value — measured in this repo's own bench at 2/2, where the element resolved fine and the flow
 * still went red because the recorded signal never fired.
 *
 * A flow with no consequence has nothing to check the heal against. Re-pointing its anchor produces
 * a flow that passes forever and proves nothing, which is worse than the drift it replaced: the
 * drift was at least visible.
 *
 * `classifyFlowAssertions` already GRADES this. Refusing on it is what turns the grade from a label
 * into a gate.
 */
function step(value: string, withConsequence: boolean): FlowStep {
  const s: FlowStep = {
    tool: ReticleTool.ACT,
    anchor: { kind: AnchorKind.TESTID, value },
    action: ActionType.CLICK,
    args: {},
  };
  if (withConsequence) s.expect = { signal: 'order:saved' };
  return s;
}

function flow(steps: FlowStep[], success?: FlowFile['success']): FlowFile {
  return {
    version: FLOW_FILE_VERSION,
    name: 'checkout',
    createdAt: 0,
    steps,
    ...(success === undefined ? {} : { success }),
  };
}

describe('a flow may only be healed if something could catch a wrong heal', () => {
  it('refuses a flow that asserts nothing at all', () => {
    const refusal = healPrecondition(flow([step('pay', false)]));
    expect(refusal?.status).toBe(HealStatus.UNFALSIFIABLE);
    expect(refusal?.message).toMatch(/nothing.*(check|catch|prove)/i);
  });

  it('allows a flow whose step declares a consequence', () => {
    expect(healPrecondition(flow([step('pay', true)]))).toBeUndefined();
  });

  it('allows a flow whose SUCCESS condition is the consequence', () => {
    // The end-condition is an assertion too — a flow can prove itself at the end rather than per step.
    expect(healPrecondition(flow([step('pay', false)], { signal: 'order:saved' }))).toBeUndefined();
  });

  it('refuses a presence-only flow — a healed locator would still satisfy it', () => {
    // This is the case the whole rule exists for. "The element is there" is exactly what a wrong
    // rebind makes true, so it cannot be the thing that validates a rebind.
    const presenceOnly = flow([
      { ...step('pay', false), expect: { element: { testid: 'receipt' } } },
    ]);
    expect(healPrecondition(presenceOnly)?.status).toBe(HealStatus.UNFALSIFIABLE);
  });

  it('names the flow and what to add, rather than only refusing', () => {
    const refusal = healPrecondition(flow([step('pay', false)]));
    expect(refusal?.message).toContain('checkout');
  });
});
