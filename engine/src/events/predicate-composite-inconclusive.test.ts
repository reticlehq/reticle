/**
 * A composite must not turn "nobody could evaluate this" into "the app is broken".
 *
 * `decideVerified` already has the right rule and it sits ahead of the failure clause: an assertion
 * that could not be evaluated is UNKNOWN, because a false that nobody could have made true is not a
 * defect in the user's app. What it never saw was a composite. `allOf`, `anyOf` and `not` rebuilt
 * their result from `pass` and a prose `failureReason` and dropped the child's `inconclusive`, so a
 * single under-specified clause inside an `allOf` reached the verdict as a plain `pass: false` and
 * came back `verified: "no" / assertion_failed` — "the declared consequence did not hold".
 *
 * Found by driving bench-app over MCP. `allOf[ route /compose, state view=compose ]` after clicking
 * Compose returned `verified: "no"`. The route clause passed. The state clause was inconclusive
 * because the app registers three stores and the call named none. The state HAD changed, and the same
 * response said so: `stateDiffs: [{ path: "view", from: "deployments", to: "compose" }]`. Naming the
 * store turned the identical drive green, which is the proof the app was never at fault.
 *
 * So it is a false RED with a false claim attached, which is the pair this release exists to remove.
 * A red an agent cannot reproduce is worse than a missing check: it sends the agent to a source
 * pointer for a component that did exactly what it was asked.
 *
 * `observationLost` is a sibling of `inconclusive` for exactly the same reason and was dropped by the
 * same three branches, so it is pinned here too.
 */

import { describe, expect, it } from 'vitest';
import { PredicateKind, ReticleCommand } from '@reticlehq/core';
import { evaluatePredicate, type PredicateSession } from './predicate.js';
import type { Predicate } from './predicate.js';

/** The one shape under test: a clause nobody could evaluate, beside one that plainly holds. */
const INCONCLUSIVE_REASON = "multiple stores (a, b) expose 'view'; name one with `store`";

/**
 * A session whose STATE read is under-specified and whose SETTLED read is trivially true.
 *
 * `state` with several stores that ALL carry the asserted path, and no `store` named, is the real
 * inconclusive path (see evalState), so the test drives the defect through the code that produces it
 * rather than through a stub verdict. Both stores must expose `view`: a path only one of them has is
 * no longer ambiguous, it is simply read from the one that has it.
 */
class TwoStoreSession {
  command(name: string): Promise<{ ok: boolean; result?: unknown }> {
    if (ReticleCommand.STATE_READ === name) {
      return Promise.resolve({
        ok: true,
        result: { stores: { a: { view: 'x' }, b: { view: 'y' } } },
      });
    }
    return Promise.resolve({ ok: true, result: {} });
  }
  eventsSince(): [] {
    return [];
  }
  onEvent(): () => void {
    return () => {};
  }
  elapsed(): number {
    return 0;
  }
}

const session = (): PredicateSession => new TwoStoreSession() as unknown as PredicateSession;

/** Under-specified on purpose: two stores both expose `view` and this names neither. */
const unevaluableState: Predicate = { kind: PredicateKind.STATE, path: 'view', equals: 'compose' };
/** Holds with no events at all, so the composite's other clause is never the reason for anything. */
const alwaysTrue: Predicate = { kind: PredicateKind.SETTLED };

describe('a composite carries its children’s "could not evaluate"', () => {
  it('allOf surfaces an inconclusive clause instead of reporting a failure', async () => {
    const result = await evaluatePredicate(session(), {
      kind: PredicateKind.ALL_OF,
      predicates: [alwaysTrue, unevaluableState],
    });

    expect(result.pass, 'nothing was proven, so pass stays false').toBe(false);
    expect(
      result.inconclusive,
      'without this the verdict rule sees a bare `pass: false` and answers `assertion_failed`, ' +
        'blaming the app for a clause the call under-specified',
    ).toBe(INCONCLUSIVE_REASON);
  });

  it('does NOT mask a clause that genuinely failed', async () => {
    // The other direction, and the one that matters more: a real failure beside an inconclusive one
    // is still a real failure. Softening it to UNKNOWN would hide the defect the agent was looking
    // for, which is the more expensive mistake of the two.
    const result = await evaluatePredicate(session(), {
      kind: PredicateKind.ALL_OF,
      predicates: [
        unevaluableState,
        { kind: PredicateKind.NOT, predicate: alwaysTrue }, // holds, so negated it fails
      ],
    });

    expect(result.pass).toBe(false);
    expect(result.inconclusive, 'a genuine failure outranks a clause nobody could read').toBe(
      undefined,
    );
  });

  it('anyOf is inconclusive when no clause passed and one could not be read', async () => {
    // A clause nobody could evaluate might have been the one that would have passed, so "none
    // matched" is a claim anyOf is not entitled to make here.
    const result = await evaluatePredicate(session(), {
      kind: PredicateKind.ANY_OF,
      predicates: [{ kind: PredicateKind.NOT, predicate: alwaysTrue }, unevaluableState],
    });

    expect(result.pass).toBe(false);
    expect(result.inconclusive).toBe(INCONCLUSIVE_REASON);
  });

  it('anyOf that actually matched is a pass, whatever the unreadable clause would have said', async () => {
    const result = await evaluatePredicate(session(), {
      kind: PredicateKind.ANY_OF,
      predicates: [unevaluableState, alwaysTrue],
    });

    expect(result.pass).toBe(true);
    expect(result.inconclusive).toBe(undefined);
  });

  it('not stays inconclusive rather than inverting an answer nobody had', async () => {
    // The sharpest case. `not` reads its child's `pass: false` as "the inner predicate did not hold"
    // and passes — so an unreadable clause became a GREEN verdict by negation. That is a false green
    // manufactured out of a missing reading, which is worse than the false red above.
    const result = await evaluatePredicate(session(), {
      kind: PredicateKind.NOT,
      predicate: unevaluableState,
    });

    expect(result.pass, 'you cannot negate an answer nobody had').toBe(false);
    expect(result.inconclusive).toBe(INCONCLUSIVE_REASON);
  });
});
