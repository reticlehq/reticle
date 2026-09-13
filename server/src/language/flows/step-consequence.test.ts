/**
 * The grade and the enforcement must describe the SAME set. This is the guard on that.
 *
 * The defect that motivated it, driven end to end over MCP against bench-app:
 *
 *   annotate { kind:'assert-signal', name:'signal-that-never-fires' }
 *     -> ok:true, "will assert signal signal-that-never-fires"
 *   flow_save   -> grade:"asserted", hasConsequenceAssertion:true, consequenceSteps:1
 *   flow_replay -> status:"ok"          <-- PASSED. The signal never fired.
 *
 * `classifyFlowAssertions` counted a step signal/net expect as a real consequence; `flow-replay`
 * evaluated element presence and `state` and nothing else. Two functions describing the same idea,
 * disagreeing — and the difference was a green that could not go red, inside the feature whose whole
 * job is to catch exactly that.
 *
 * `assertStepExpect` now compiles every step expect through the same `successToPredicate` the
 * flow-level `success` has always used. The invariant guarded here is ONE-DIRECTIONAL:
 *
 *   everything the grade counts as a consequence must be something replay actually evaluates.
 *
 * The converse is deliberately not required, and `console` is why. A replay does enforce
 * `expect.console` — but `{ level: 'error', absent: true }` is a GUARD, not proof the app did
 * anything, and grading it as a consequence would let a flow that clicks Checkout and asserts only
 * "no console error" report that the goal was verified. Enforced-but-not-credited is the safe
 * direction; credited-but-unenforced is the false green.
 */

import { describe, expect, it } from 'vitest';
import { classifyFlowAssertions, FlowAssertionGrade } from './flow-classify.js';
import { successToPredicate } from './flow-success.js';
import type { FlowExpect, FlowFile } from '@reticlehq/core';

const NO_DYNAMIC = new Set<string>();

const flow = (stepExpect: FlowExpect): FlowFile =>
  ({
    version: 1,
    name: 'probe',
    steps: [{ tool: 'reticle_act', anchor: { kind: 'testid', value: 'x' }, expect: stepExpect }],
  }) as unknown as FlowFile;

/** Every expect kind the recorder and reticle_annotate can produce. */
const KINDS: readonly { label: string; expect: FlowExpect; consequence: boolean }[] = [
  { label: 'signal', expect: { signal: 'order:placed' }, consequence: true },
  { label: 'net', expect: { net: { urlContains: '/api/order', status: 200 } }, consequence: true },
  { label: 'state', expect: { state: { path: 'cart.total', equals: 2 } }, consequence: true },
  // Enforced by replay, deliberately NOT credited as a consequence — see the header.
  { label: 'console', expect: { console: { level: 'error', absent: true } }, consequence: false },
  { label: 'element', expect: { element: { testid: 'toast' } }, consequence: false },
];

describe('what the grade counts is exactly what a replay enforces', () => {
  it.each(KINDS)('$label: anything replay can check is compilable', ({ expect: e }) => {
    // If this is undefined, replay has nothing to evaluate and the flow cannot fail on it.
    expect(successToPredicate(e, NO_DYNAMIC)).toBeDefined();
  });

  it.each(KINDS.filter((k) => k.consequence))(
    '$label: a consequence in the grade is a consequence replay evaluates',
    ({ expect: e }) => {
      const c = classifyFlowAssertions(flow(e));
      expect(c.hasConsequenceAssertion, 'graded as a real consequence').toBe(true);
      expect(c.grade).toBe(FlowAssertionGrade.ASSERTED);
      expect(
        successToPredicate(e, NO_DYNAMIC),
        'and replay compiles it to a predicate',
      ).toBeDefined();
    },
  );

  it('console is enforced but not credited — the safe direction', () => {
    const c = classifyFlowAssertions(flow({ console: { level: 'error', absent: true } }));
    expect(
      successToPredicate({ console: { level: 'error', absent: true } }, NO_DYNAMIC),
    ).toBeDefined();
    expect(c.hasConsequenceAssertion, 'a clean console does not prove the feature worked').toBe(
      false,
    );
  });

  it('element presence stays presence-only — a wrong element can fake it', () => {
    expect(classifyFlowAssertions(flow({ element: { testid: 'toast' } })).grade).toBe(
      FlowAssertionGrade.PRESENCE_ONLY,
    );
  });

  it('a dynamic-marked element is not asserted, and is not graded as one either', () => {
    // The one place the two rules are allowed to differ, and it differs in the safe direction.
    expect(
      successToPredicate({ element: { testid: 'clock' } }, new Set(['clock'])),
    ).toBeUndefined();
  });
});
