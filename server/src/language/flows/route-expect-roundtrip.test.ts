import { describe, expect, it } from 'vitest';
import {
  predicateToExpect,
  enforcedOnReplay,
} from '../../judgement/outcome/predicate-to-expect.js';
import { successToPredicate } from './flow-success.js';
import { classifyFlowAssertions, FlowAssertionGrade } from './flow-classify.js';
import { FlowExpectSchema, PredicateKind } from '@reticlehq/core';

/**
 * A route assertion SURVIVES being recorded.
 *
 * Found by driving a real upstream app — Vercel's app-playground — over MCP. Clicking a nav link
 * with `until: { kind: "route", contains: "layouts" }` returned `verified: "yes"` at route grade,
 * and the flow saved from that same drive graded `assertion-free`, warning that it "claims to
 * verify a goal it cannot actually check". Both statements were true, which is the problem:
 * `FlowExpect` had signal, net, console, element, text and state, and no route.
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

  it('is carried into the recorded expectation', () => {
    expect(predicateToExpect(predicate)).toEqual({ route: { contains: 'layouts' } });
  });

  it('survives the PUBLISHED schema, so it is really on disk', () => {
    // A field the schema strips is a field that does not exist, however carefully the code sets it.
    expect(FlowExpectSchema.parse({ route: { pathname: '/layouts' } }).route).toEqual({
      pathname: '/layouts',
    });
  });

  it('comes back as the same predicate on replay', () => {
    const none = new Set<string>();
    expect(successToPredicate({ route: { contains: 'layouts' } }, none)).toEqual(predicate);
    expect(successToPredicate({ route: { pathname: '/layouts' } }, none)).toEqual({
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
          expect: { route: { contains: 'layouts' } },
        },
      ],
    } as never;
    const graded = classifyFlowAssertions(flow);
    expect(graded.grade).toBe(FlowAssertionGrade.PRESENCE_ONLY);
    expect(graded.weakSteps).toBe(1);
  });

  it('still refuses the kinds that have no representation', () => {
    // The guarantee that this did not become "carry anything": an animation assertion is still not
    // invented into the file.
    expect(predicateToExpect({ kind: PredicateKind.ANIMATION })).toBeUndefined();
  });
});

/**
 * The SECOND allowlist, which is the one that actually decides what reaches disk.
 *
 * `predicateToExpect` says what CAN be expressed; `enforcedOnReplay` says what replay will check,
 * and only what survives both is recorded. They are two lists answering one question, and the file
 * that holds them already records them drifting apart once. They drifted again the day `route` was
 * added — the field landed, the mapping landed, and a route assertion still reached disk as nothing
 * because this list had not heard of it. Driving a real app is what showed it; every unit test at
 * the time was green.
 */
describe('what replay will actually enforce', () => {
  it('keeps a route, so the recorded assertion survives to the file', () => {
    expect(enforcedOnReplay({ route: { contains: 'layouts' } })).toEqual({
      route: { contains: 'layouts' },
    });
  });

  it('still drops what replay cannot check, so nothing is recorded that will not be enforced', () => {
    expect(enforcedOnReplay({ text: { contains: 'hello' } })).toBeUndefined();
  });
});
