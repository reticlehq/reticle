/**
 * Grade a single assertion predicate as a CONSEQUENCE or a mere PRESENCE check — the same distinction
 * classifyFlowAssertions applies to saved flows, now applied to ad-hoc reticle_assert calls.
 *
 * Why (grounded, same sources as flow-classify): a test that only checks an element is present is
 * weak — a locator healed to the wrong element, or a stale render, can satisfy it while the feature
 * is broken (Fowler, *Assertion-Free Testing*; Dodds, *Make Your Test Fail*). A signal/net assertion
 * verifies an observable consequence a wrong element cannot fake. When an agent asserts only
 * presence, we pass the verdict but nudge it toward a consequence — the success-oracle thesis.
 *
 * Pure: no IO, no clock.
 */

import { isConsequenceKind, isPresenceKind, PredicateKind } from '@reticlehq/core';
import { HonestyGrade } from '../honesty/honesty.js';
import type { Predicate } from '../events/predicate.js';

export const PRESENCE_ONLY_ADVICE =
  'This predicate only checks element/text presence, not an observable consequence. A locator healed to the wrong element (or a stale render) can satisfy it while the feature is broken. Prefer a { signal } or { net } assertion (or allOf it with one) so green means the feature actually worked.';

interface PredicateKinds {
  /** A signal/net leaf is present — proves the app did something a wrong element cannot fake. */
  consequence: boolean;
  /** An element/text leaf is present — a weak presence check. */
  presence: boolean;
}

function walk(predicate: Predicate, negated = false): PredicateKinds {
  if (PredicateKind.ALL_OF === predicate.kind || PredicateKind.ANY_OF === predicate.kind) {
    const subs = predicate.predicates.map((p) => walk(p, negated));
    return {
      consequence: subs.some((s) => s.consequence),
      presence: subs.some((s) => s.presence),
    };
  }
  // Under a NOT, checking content strengthens nothing, so the exemption below must not apply. The
  // nudge warns that a healed or wrong locator can satisfy the predicate, and for an ABSENCE claim a
  // wrong locator satisfies it trivially: "the error message is gone" is true of a selector that
  // never matched anything in the first place. Negation makes a presence check weaker, not stronger.
  if (PredicateKind.NOT === predicate.kind) return walk(predicate.predicate, true);
  // Leaf: classify against the single source of truth in core. Kinds that are neither consequence
  // nor presence (route/console/settled/animation) correctly return false for both.
  return {
    consequence: isConsequenceKind(predicate.kind),
    presence: isPresenceKind(predicate.kind) && (negated || !assertsElementContent(predicate)),
  };
}

/**
 * An element predicate that checks the element's CONTENT, not merely that it is there.
 *
 * The presence nudge exists because "a locator healed to the wrong element, or a stale render, can
 * satisfy this while the feature is broken". That is exactly true of `{ element, role, name }` and
 * exactly false of `{ element, role, name, value: "274.58" }`: a wrong element now has to carry the
 * same value to pass, which is the thing the nudge is warning cannot be relied on.
 *
 * Kept as a nudge-level distinction rather than a new honesty grade. The grade still reads
 * `presence`, which UNDERSTATES what was proved, and understating is the safe direction for a field
 * whose whole job is to qualify a green. Telling an agent that a value check "only checks presence"
 * is the direction that costs something: it argues for replacing an assertion that is already sound.
 */
function assertsElementContent(predicate: Predicate): boolean {
  if (predicate.kind !== PredicateKind.ELEMENT) return false;
  return predicate.query?.value !== undefined || predicate.query?.text !== undefined;
}

/**
 * True when the predicate asserts ONLY element/text presence with no signal/net consequence anywhere
 * — the weak pattern worth nudging. A predicate that mixes in a consequence, or that checks something
 * other than presence (route/console/settled), is not flagged.
 */
/**
 * Advice for an assertion pinned to a status Reticle derived rather than one a server sent.
 */
export const DERIVED_IPC_STATUS_ADVICE =
  'This asserts on a status code Reticle DERIVED — IPC has none. Prefer `{ ok: false }`, which ' +
  'describes what the app did rather than how Reticle encoded it, and cannot drift if that encoding ' +
  'changes. The `error` field carries the message the main process or Rust command actually returned.';

/**
 * Does this predicate pin an IPC call to a status code?
 *
 * The 200/500 on an IPC record is a convenience so `reticle_network { status }` keeps working across
 * runtimes — it is not something any server sent. An assertion built on it is really an assertion
 * about Reticle's encoding, and would silently stop meaning what it meant if that encoding changed.
 * Recognised by the `ipc://` scheme, so a genuine HTTP status is never second-guessed.
 */
export function assertsDerivedIpcStatus(predicate: Predicate): boolean {
  if (PredicateKind.ALL_OF === predicate.kind || PredicateKind.ANY_OF === predicate.kind) {
    return predicate.predicates.some(assertsDerivedIpcStatus);
  }
  if (PredicateKind.NOT === predicate.kind) return assertsDerivedIpcStatus(predicate.predicate);
  if (predicate.kind !== PredicateKind.NET) return false;
  return (
    predicate.status !== undefined &&
    predicate.ok === undefined &&
    (predicate.urlContains ?? '').startsWith('ipc://')
  );
}

export function isPresenceOnlyAssertion(predicate: Predicate): boolean {
  const kinds = walk(predicate);
  return kinds.presence && !kinds.consequence;
}

/**
 * The tier a predicate actually proves, for the honesty block on a verdict.
 *
 * A signal or a network consequence is evidence the APP produced; a state read is one step removed;
 * presence of an element is the weakest, because a wrong or healed element can satisfy it. The
 * verdict carries this so "it passed" is always qualified by what it passed on.
 */
export function gradeOfPredicate(predicate: Predicate): HonestyGrade {
  switch (predicate.kind) {
    case PredicateKind.SIGNAL:
      return HonestyGrade.SIGNAL;
    case PredicateKind.NET:
      return HonestyGrade.NET;
    case PredicateKind.STATE:
      return HonestyGrade.STATE;
    default:
      return HonestyGrade.PRESENCE;
  }
}
