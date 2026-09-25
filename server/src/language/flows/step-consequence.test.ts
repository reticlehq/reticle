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
 * `assertStepExpect` waits on the step's expect directly, which is the same predicate the
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
import type { Predicate, FlowFile } from '@reticlehq/core';

const flow = (stepExpect: Predicate): FlowFile =>
  ({
    version: 1,
    name: 'probe',
    steps: [{ tool: 'reticle_act', anchor: { kind: 'testid', value: 'x' }, expect: stepExpect }],
  }) as unknown as FlowFile;

/** Every expect kind the recorder and reticle_annotate can produce. */
const KINDS: readonly { label: string; expect: Predicate; consequence: boolean }[] = [
  { label: 'signal', expect: { kind: 'signal', name: 'order:placed' }, consequence: true },
  {
    label: 'net',
    expect: { kind: 'net', urlContains: '/api/order', status: 200 },
    consequence: true,
  },
  { label: 'state', expect: { kind: 'state', path: 'cart.total', equals: 2 }, consequence: true },
  // Enforced by replay, deliberately NOT credited as a consequence — see the header.
  {
    label: 'console',
    expect: { kind: 'console', level: 'error', absent: true },
    consequence: false,
  },
  { label: 'element', expect: { kind: 'element', query: { testid: 'toast' } }, consequence: false },
];

describe('what the grade counts is exactly what a replay enforces', () => {
  /*
   * The compilability half of this file is GONE, and its absence is the point.
   *
   * It asserted that every kind the grade credits could be compiled to a predicate replay could
   * evaluate, because the two lived in different code and could disagree. A step's expect IS a
   * predicate now: the thing graded and the thing waited on are one object, so the question cannot
   * have two answers and a test of it would be a tautology with a green tick on it.
   *
   * The grading half below is still a real question and stays.
   */
  it.each(KINDS.filter((k) => k.consequence))(
    '$label: a consequence in the grade is a consequence replay evaluates',
    ({ expect: e }) => {
      const c = classifyFlowAssertions(flow(e));
      expect(c.hasConsequenceAssertion, 'graded as a real consequence').toBe(true);
      expect(c.grade).toBe(FlowAssertionGrade.ASSERTED);
    },
  );

  it('console is enforced but not credited — the safe direction', () => {
    const c = classifyFlowAssertions(flow({ kind: 'console', level: 'error', absent: true }));
    expect(c.hasConsequenceAssertion, 'a clean console does not prove the feature worked').toBe(
      false,
    );
  });

  it('element presence stays presence-only — a wrong element can fake it', () => {
    expect(
      classifyFlowAssertions(flow({ kind: 'element', query: { testid: 'toast' } })).grade,
    ).toBe(FlowAssertionGrade.PRESENCE_ONLY);
  });

  /*
   * The dynamic skip moved to where it applies. It was asserted here against the compiler, which no
   * longer exists; the rule itself now lives in `assertSuccess`, which drops a dynamic element
   * clause from the success oracle, and is tested there against the function that does it.
   */
});
