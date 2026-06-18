/**
 * Grade a single assertion predicate as a CONSEQUENCE or a mere PRESENCE check — the same distinction
 * classifyFlowAssertions applies to saved flows, now applied to ad-hoc iris_assert calls.
 *
 * Why (grounded, same sources as flow-classify): a test that only checks an element is present is
 * weak — a locator healed to the wrong element, or a stale render, can satisfy it while the feature
 * is broken (Fowler, *Assertion-Free Testing*; Dodds, *Make Your Test Fail*). A signal/net assertion
 * verifies an observable consequence a wrong element cannot fake. When an agent asserts only
 * presence, we pass the verdict but nudge it toward a consequence — the success-oracle thesis.
 *
 * Pure: no IO, no clock.
 */

import type { Predicate } from '../events/predicate.js';

export const PRESENCE_ONLY_ADVICE =
  'This predicate only checks element/text presence, not an observable consequence. A locator healed to the wrong element (or a stale render) can satisfy it while the feature is broken. Prefer a { signal } or { net } assertion — or allOf it with one — so green means the feature actually worked.';

interface PredicateKinds {
  /** A signal/net leaf is present — proves the app did something a wrong element cannot fake. */
  consequence: boolean;
  /** An element/text leaf is present — a weak presence check. */
  presence: boolean;
}

function walk(predicate: Predicate): PredicateKinds {
  switch (predicate.kind) {
    case 'signal':
    case 'net':
      return { consequence: true, presence: false };
    case 'element':
    case 'text':
      return { consequence: false, presence: true };
    case 'route':
    case 'console':
    case 'animation':
    case 'settled':
      // Observable but not the weak presence pattern we nudge — neither flags the advice.
      return { consequence: false, presence: false };
    case 'allOf':
    case 'anyOf': {
      const subs = predicate.predicates.map(walk);
      return {
        consequence: subs.some((s) => s.consequence),
        presence: subs.some((s) => s.presence),
      };
    }
    case 'not':
      return walk(predicate.predicate);
  }
}

/**
 * True when the predicate asserts ONLY element/text presence with no signal/net consequence anywhere
 * — the weak pattern worth nudging. A predicate that mixes in a consequence, or that checks something
 * other than presence (route/console/settled), is not flagged.
 */
export function isPresenceOnlyAssertion(predicate: Predicate): boolean {
  const kinds = walk(predicate);
  return kinds.presence && !kinds.consequence;
}
