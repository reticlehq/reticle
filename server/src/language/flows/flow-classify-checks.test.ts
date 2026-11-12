/**
 * The save summary says which checks a flow runs (#1840).
 *
 * After `reticle_flow_save` of a `reticle_act { steps }` journey, the summary said
 * `consequenceSteps: 0` and recommended a signal or network check. The journey checked text,
 * element state and the route in every sub-step. Nothing in the summary said so, and an agent read
 * the note as "this flow checks nothing" and could rewrite a correct flow.
 */
import { describe, expect, it } from 'vitest';
import { AnchorKind, FLOW_FILE_VERSION, ReticleTool } from '@reticlehq/core';
import type { FlowFile, FlowStep, Predicate } from '@reticlehq/core';
import { classifyFlowAssertions, FlowAssertionGrade } from './flow-classify.js';

const sub = (expect?: Predicate): FlowStep => ({
  tool: ReticleTool.ACT,
  anchor: { kind: AnchorKind.ROLE, role: 'button', name: 'Next' },
  ...(expect === undefined ? {} : { expect }),
});

/** The reported shape: one journey step whose four sub-steps each check the page. */
const journey: FlowFile = {
  version: FLOW_FILE_VERSION,
  name: 'onboarding',
  createdAt: 0,
  steps: [
    {
      tool: ReticleTool.ACT_SEQUENCE,
      anchor: { kind: AnchorKind.ROLE, role: 'button', name: 'Start' },
      steps: [
        sub({ kind: 'text', contains: 'Step 1 of 3' }),
        sub({ kind: 'element', query: { role: 'checkbox', name: 'Terms' }, state: 'checked' }),
        sub({
          kind: 'allOf',
          predicates: [
            { kind: 'route', pathname: '/welcome' },
            { kind: 'text', contains: 'Welcome' },
          ],
        }),
        sub({ kind: 'text', contains: 'Done' }),
      ],
    },
  ],
};

describe('a presence-only journey, as the save summary reports it', () => {
  const c = classifyFlowAssertions(journey);

  it('counts the sub-steps, not only the journey step', () => {
    expect(c.totalSteps).toBe(5);
    expect(c.weakSteps).toBe(4);
  });

  it('lists the kinds of checks the flow runs, composites flattened', () => {
    expect(c.grade).toBe(FlowAssertionGrade.PRESENCE_ONLY);
    expect(c.checks).toEqual({ element: 1, route: 1, text: 3 });
  });

  it('names those checks in the note, so it does not read as "checks nothing"', () => {
    expect(c.warning).toContain('This flow checks text (3), element (1) and route (1)');
    expect(c.warning).toContain('A locator healed to the wrong element can still pass');
  });

  it('matches the summary snapshot', () => {
    expect({ grade: c.grade, totalSteps: c.totalSteps, checks: c.checks, warning: c.warning })
      .toMatchInlineSnapshot(`
        {
          "checks": {
            "element": 1,
            "route": 1,
            "text": 3,
          },
          "grade": "presence-only",
          "totalSteps": 5,
          "warning": "This flow checks text (3), element (1) and route (1) on the page. These are presence checks, not an observable consequence (signal/network). A locator healed to the wrong element can still pass it. Add a consequence assertion (assert-signal / assert-net / success-state).",
        }
      `);
  });
});

describe('the checks list', () => {
  it('counts a consequence and the success state too', () => {
    const flow: FlowFile = {
      ...journey,
      steps: [sub({ kind: 'net', urlContains: '/api/save', status: 200 })],
      success: { kind: 'signal', name: 'saved' },
    };
    const c = classifyFlowAssertions(flow);
    expect(c.grade).toBe(FlowAssertionGrade.ASSERTED);
    expect(c.checks).toEqual({ net: 1, signal: 1 });
  });

  it('is absent from a flow that checks nothing, and the note is unchanged', () => {
    const c = classifyFlowAssertions({ ...journey, steps: [sub(), sub()] });
    expect(c.checks).toBeUndefined();
    expect(c.warning).toContain('asserts no observable consequence');
  });
});
