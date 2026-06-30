import { describe, expect, it } from 'vitest';
import { FLOW_FILE_VERSION, AnchorKind } from '@reticlehq/protocol';
import type { FlowFile, FlowStep, FlowExpect } from '@reticlehq/protocol';
import { ReticleTool } from '../tools/tool-names.js';
import { classifyFlowAssertions, FlowAssertionGrade } from './flow-classify.js';

function step(expect?: FlowExpect): FlowStep {
  const s: FlowStep = { tool: ReticleTool.ACT, anchor: { kind: AnchorKind.TESTID, value: 'x' } };
  if (expect !== undefined) s.expect = expect;
  return s;
}

function flow(steps: FlowStep[], success?: FlowExpect): FlowFile {
  const f: FlowFile = { version: FLOW_FILE_VERSION, name: 'f', createdAt: 0, steps };
  if (success !== undefined) f.success = success;
  return f;
}

describe('classifyFlowAssertions', () => {
  it('flags a flow that acts but asserts nothing as assertion-free', () => {
    const c = classifyFlowAssertions(flow([step(), step()]));
    expect(c.grade).toBe(FlowAssertionGrade.ASSERTION_FREE);
    expect(c.hasConsequenceAssertion).toBe(false);
    expect(c.totalSteps).toBe(2);
    expect(c.warning).toContain('asserts no observable consequence');
  });

  it('flags element-only checks as presence-only (a healed wrong locator could pass)', () => {
    const c = classifyFlowAssertions(flow([step(), step({ element: { testid: 'panel' } })]));
    expect(c.grade).toBe(FlowAssertionGrade.PRESENCE_ONLY);
    expect(c.hasConsequenceAssertion).toBe(false);
    expect(c.weakSteps).toBe(1);
    expect(c.warning).toContain('element presence');
  });

  it('treats a signal assertion as a real consequence', () => {
    const c = classifyFlowAssertions(flow([step({ signal: 'order:placed' })]));
    expect(c.grade).toBe(FlowAssertionGrade.ASSERTED);
    expect(c.hasConsequenceAssertion).toBe(true);
    expect(c.consequenceSteps).toBe(1);
    expect(c.warning).toBeUndefined();
  });

  it('treats a network assertion as a real consequence', () => {
    const c = classifyFlowAssertions(
      flow([step({ net: { urlContains: '/api/order', status: 200 } })]),
    );
    expect(c.grade).toBe(FlowAssertionGrade.ASSERTED);
    expect(c.consequenceSteps).toBe(1);
  });

  it('counts a consequence success end-condition even with no step expects', () => {
    const c = classifyFlowAssertions(flow([step(), step()], { signal: 'checkout:done' }));
    expect(c.grade).toBe(FlowAssertionGrade.ASSERTED);
    expect(c.successIsConsequence).toBe(true);
  });

  it('an element-only success is still presence-only', () => {
    const c = classifyFlowAssertions(flow([step()], { element: { testid: 'thanks' } }));
    expect(c.grade).toBe(FlowAssertionGrade.PRESENCE_ONLY);
    expect(c.successIsConsequence).toBe(false);
  });

  it('counts expects on act_sequence sub-steps', () => {
    const seq: FlowStep = {
      tool: ReticleTool.ACT_SEQUENCE,
      anchor: { kind: AnchorKind.TESTID, value: 'x' },
      steps: [step(), step({ signal: 'saved' })],
    };
    const c = classifyFlowAssertions(flow([seq]));
    expect(c.hasConsequenceAssertion).toBe(true);
    expect(c.consequenceSteps).toBe(1);
  });
});

/** flow() variant that also declares a business intent. */
function intentFlow(steps: FlowStep[], intent: string, success?: FlowExpect): FlowFile {
  return { ...flow(steps, success), intent };
}

describe('classifyFlowAssertions — business intent + outcome oracle', () => {
  it('a flow with no intent is intentVerified=false and carries no intent', () => {
    const c = classifyFlowAssertions(flow([step({ signal: 'deploy:shipped' })]));
    expect(c.intent).toBeUndefined();
    expect(c.intentVerified).toBe(false);
  });

  it('intent + a consequence success outcome → intentVerified (the goal can actually fail)', () => {
    const c = classifyFlowAssertions(
      intentFlow([step()], 'ship a deploy to production', { signal: 'deploy:shipped' }),
    );
    expect(c.intent).toBe('ship a deploy to production');
    expect(c.intentVerified).toBe(true);
    expect(c.grade).toBe(FlowAssertionGrade.ASSERTED);
    expect(c.warning).toBeUndefined();
  });

  it('intent without any observable outcome → NOT verified, with the intent-gap warning', () => {
    const c = classifyFlowAssertions(intentFlow([step()], 'ship a deploy to production'));
    expect(c.intentVerified).toBe(false);
    expect(c.warning).toContain('declares a business intent but asserts no observable outcome');
  });

  it('intent with only a presence-only check is NOT verified (a healed locator could fake it)', () => {
    const c = classifyFlowAssertions(
      intentFlow([step()], 'open the deploy modal', { element: { testid: 'deploy-modal' } }),
    );
    expect(c.intentVerified).toBe(false);
    expect(c.warning).toContain('declares a business intent but asserts no observable outcome');
  });
});
