/**
 * Which predicates can be satisfied by something that was already true before the action.
 *
 * Event-based kinds (net, signal, console, animation, settled) are evaluated against the
 * event buffer floored at the act's own cursor, so a stale event cannot satisfy them — that floor is
 * why `act_and_wait` can trust them at all.
 *
 * `element` and `text` read the LIVE DOM, `route` can fall back to the current route, and `state` reads
 * live store memory via STATE_READ — where no event floor applies. A condition that held before the
 * click holds after it and passes instantly, whatever the action did. Measured in the field: a click
 * asserted with `{ kind: 'text', contains: 'Parallel Routes' }` returned `verified: "yes"` in 478ms
 * against `routeChanges: 0`, because the predicate matched the nav link that was already on screen —
 * the real navigation landed 1.8 seconds later. Similarly, a pre-existing store value (e.g. cart.count == 3)
 * satisfies an inert action if not checked before dispatch.
 *
 * So these are the kinds worth evaluating BEFORE the act, to find out whether the green means
 * anything.
 */
import { PredicateKind, type ElementDescriptor } from '@reticlehq/core';
import type { Predicate } from '../question/predicate.js';

export function readsDomState(predicate: Predicate): boolean {
  switch (predicate.kind) {
    // ROUTE is here, and it did not used to be. It was purely event-based — satisfiable only by a
    // navigation inside the act's window, and therefore unable to be answered by the past — so it
    // sat with the floored kinds below.
    //
    // It gained a fallback to the CURRENT route for the case where the window holds no route change,
    // which is what makes "did the session survive a reload?" answerable at all. Without a
    // before-check that fallback is a guaranteed green: the app is already on /login, the click's
    // handler is broken, nothing navigates, and an assertion that the action reached /login passes
    // on the strength of it having been there all along. A bare `{ kind: 'route' }` becomes
    // unconditionally true, because there is always a current route.
    //
    // One extra query on the act path buys `already_true`, reported as UNKNOWN with the reason
    // rather than as a pass. The fallback removed a false red; this is what stops it becoming a
    // false green, and that is the trade this codebase never makes.
    //
    // STATE is here for the same reason: it is evaluated via STATE_READ against live in-memory stores
    // rather than through the floored event buffer. If the store already holds the expected value
    // before dispatch, an inert click would immediately pass post-dispatch on the pre-existing state.
    // Evaluating before dispatch routes that pre-existing condition into already_true.
    case PredicateKind.ELEMENT:
    case PredicateKind.TEXT:
    case PredicateKind.ROUTE:
    case PredicateKind.STATE:
      return true;
    case PredicateKind.ALL_OF:
    case PredicateKind.ANY_OF:
      return predicate.predicates.some(readsDomState);
    case PredicateKind.NOT:
      return readsDomState(predicate.predicate);
    default:
      return false;
  }
}

/** True when `value` looks like an element/text predicate's passing evidence — an array of descriptors. */
function isDescriptorArray(value: unknown): value is readonly ElementDescriptor[] {
  if (!Array.isArray(value)) return false;
  return (value as unknown[]).every((v) => {
    if ('object' !== typeof v || null === v) return false;
    return 'boolean' === typeof (v as Record<string, unknown>)['visible'];
  });
}

/**
 * #889: an `already_true` verdict says the declared consequence held before the action, so nothing
 * was proven — but a `text`/`element` predicate matches DOM presence by default, not visibility (a
 * caller has to pass `visible: true` to ask for that). A dialog's content mounted-but-hidden before
 * the click therefore reads as "already true", identically to genuinely-visible content that was
 * already on screen — and the `already_true` message named neither which node it matched nor that
 * the match was invisible, which is what made it read as proof of nothing rather than as the
 * mid-load/hidden-mount trap it actually was.
 *
 * True only when the predicate itself did not ask for a state (an explicit `visible`/other state
 * constraint already means the caller saw and handled this) AND every matched element is hidden —
 * one visible match among several is a fair, ordinary read and is left alone.
 */
export function alreadyTrueHiddenMatch(predicate: Predicate, evidence: unknown): boolean {
  if (predicate.kind !== PredicateKind.ELEMENT && predicate.kind !== PredicateKind.TEXT) {
    return false;
  }
  if (predicate.kind === PredicateKind.ELEMENT && predicate.state !== undefined) return false;
  if (predicate.kind === PredicateKind.TEXT && true === predicate.visible) return false;
  if (!isDescriptorArray(evidence) || 0 === evidence.length) return false;
  return evidence.every((el) => !el.visible);
}
