/**
 * A Harness check that only claimed where the page would go, and missed.
 *
 * The driver declares a consequence before each click. When all it declares is a route ("this will
 * leave /overview") and the route does something else, that is the driver guessing wrong about an
 * in-page control (a Mine/Team toggle, a project picker, a dialog, a tab), not the app failing:
 * three runs whose every goal was met read NOT PROVED with "findings" that were the driver's own
 * predictions. Such a check is undecided, never failed, and never a finding.
 *
 * ponytail: a route-only claim is always read as a guess. A link that should navigate and does not
 * is still found, by the crawl and by the goals, which are what a run is judged on.
 */
import { PredicateKind, asRecord, asString } from '@reticlehq/core';

/** Said of a route guess that missed, on the step. */
export const MSG_ROUTE_GUESS_MISSED =
  "the drive guessed this would change the route and it did not go where it said: the driver's wrong guess, not an app defect";

/** Said of a route claim whose click opened a menu or dialog instead: the route comes after it. */
export const MSG_OPENED_MENU =
  'it opened a menu or dialog; the route it named comes after a choice in it — progress, not a check';

/** Whether a declared predicate claims nothing but a route (or leaving one). */
export function claimsOnlyRoute(predicate: unknown): boolean {
  const p = asRecord(predicate);
  const kind = asString(p['kind']);
  if (PredicateKind.ROUTE === kind) return true;
  return (
    PredicateKind.NOT === kind && PredicateKind.ROUTE === asString(asRecord(p['predicate'])['kind'])
  );
}
