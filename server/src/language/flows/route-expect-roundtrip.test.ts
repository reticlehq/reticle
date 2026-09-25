import { describe, expect, it } from 'vitest';
import { classifyFlowAssertions, FlowAssertionGrade } from './flow-classify.js';
import { FlowFileSchema, PredicateKind, flowExpectToPredicate } from '@reticlehq/core';

/**
 * A route assertion SURVIVES being recorded.
 *
 * Found by driving a real upstream app — Vercel's app-playground — over MCP. Clicking a nav link
 * with `until: { kind: "route", contains: "layouts" }` returned `verified: "yes"` at route grade,
 * and the flow saved from that same drive graded `assertion-free`, warning that it "claims to
 * verify a goal it cannot actually check". Both statements were true, which is the problem:
 * `Predicate` had signal, net, console, element, text and state, and no route.
 *
 * Navigation is one of the commonest journeys there is, so this is not a corner: every
 * route-asserted drive persisted a flow that can never go red.
 *
 * `predicate-to-expect` already refuses to carry `animation`, `anyOf` and `not`, on the reasoning
 * that "inventing one would write an assertion into the file that the agent never made". That
 * reasoning is right and it does NOT apply here: the agent made a route assertion in so many words.
 * Carrying it is the opposite of inventing one.
 */

describe('a route assertion round-trips through a saved flow', () => {
  const predicate = { kind: PredicateKind.ROUTE, contains: 'layouts' } as const;

  /*
   * The two allowlists this file was written about are GONE, and so are the four tests that pinned
   * them. `predicateToExpect` asked whether a route could be EXPRESSED in the flat format, and
   * `enforcedOnReplay` whether replay would then CHECK it — two lists answering one question, which
   * is how `route` came to land in one and not the other and reach disk as nothing.
   *
   * A step's expect is the predicate itself now. There is no second format to be expressible in and
   * no filter to survive, so the drift those tests existed to catch cannot happen. What is left is
   * the property they were protecting, asserted end to end.
   */
  it('reaches the file byte for byte, through the published schema', () => {
    const parsed = FlowFileSchema.safeParse({
      version: 1,
      name: 'nav',
      createdAt: 1,
      steps: [
        {
          tool: 'reticle_act',
          anchor: { kind: 'testid', value: 'nav-layouts' },
          expect: predicate,
        },
      ],
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.steps[0]?.expect).toEqual(predicate);
  });

  it('is what replay waits on, unchanged', () => {
    // No compilation step to lose it in: the thing graded and the thing waited on are one object.
    expect(flowExpectToPredicate({ route: { contains: 'layouts' } })).toEqual(predicate);
    expect(flowExpectToPredicate({ route: { pathname: '/layouts' } })).toEqual({
      kind: PredicateKind.ROUTE,
      pathname: '/layouts',
    });
  });

  it('makes the flow PRESENCE-ONLY rather than assertion-free', () => {
    // Presence, not consequence, and the choice is deliberate. A route change is observed on a
    // channel rather than queried from the DOM, so unlike `element` it cannot be satisfied by a
    // healed-but-wrong locator — an argument for grading it higher. What settles it the other way
    // is that the LIVE verdict already grades a route assertion `presence`: a flow that graded
    // stronger on disk than the drive that produced it would be a saved claim nobody made.
    //
    // Either way it is no longer `assertion-free`, which is the thing that mattered — that grade
    // means "replays green whatever the app does", and a recorded navigation is not that.
    const flow = {
      name: 'nav',
      version: 1,
      steps: [
        {
          tool: 'reticle_act',
          anchor: { kind: 'testid', value: 'nav-layouts' },
          expect: { kind: 'route', contains: 'layouts' },
        },
      ],
    } as never;
    const graded = classifyFlowAssertions(flow);
    expect(graded.grade).toBe(FlowAssertionGrade.PRESENCE_ONLY);
    expect(graded.weakSteps).toBe(1);
  });
});
