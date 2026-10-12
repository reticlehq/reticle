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

/** How many known pages a line names; a map of hundreds is a list nobody reads. */
const MAX_ROUTES_NAMED = 20;

/** The pages the map knows, as one line for the model. */
export const knownPagesLine = (routes: readonly string[]): string =>
  routes.slice(0, MAX_ROUTES_NAMED).join(', ');

/** The route a claim names arriving at, when it names one (`not` a route names none). */
function claimedRoute(predicate: unknown): string | undefined {
  const p = asRecord(predicate);
  if (PredicateKind.ROUTE !== asString(p['kind'])) return undefined;
  return asString(p['pathname']) ?? asString(p['contains']);
}

/**
 * What to do instead of guessing again, after a route guess missed: the known page it was after,
 * by its route, or the pages the map knows. Undefined when the map knows none.
 */
export function routeHint(predicate: unknown, routes: readonly string[]): string | undefined {
  if (0 === routes.length) return undefined;
  const wanted = claimedRoute(predicate);
  const known = wanted === undefined ? undefined : routes.find((r) => r.includes(wanted));
  return known === undefined
    ? `That control does not lead where you guessed. The pages this app has: ${knownPagesLine(routes)}. Go to one by its link or reticle_navigate, rather than guessing which control leads there.`
    : `That control does not lead to ${known}. It is a page this app has: press its link, or reticle_navigate { url: "${known}" }, rather than guessing another control.`;
}
