/**
 * The `route` oracle. Split out of predicate-eval.ts, which was at the file-size backstop.
 *
 * Route is the one predicate with TWO sources of truth — a navigation inside the window and where the
 * app is right now — and keeping that reconciliation in one place is what makes it readable.
 */
import { EventType, PredicateKind, type ReticleEvent } from '@reticlehq/core';
import { type EvalResult, type Predicate } from './predicate-eval.js';
import { routeOfEvent } from './route-of-event.js';
/**
 * Which fact answered a `route` predicate: a navigation inside the window, or where the app is now.
 *
 * Reported on every route result because the two are different claims. "It changed to /login" proves
 * a redirect; "it was already /login" does not, and an agent asserting a post-login redirect has to
 * be able to tell them apart. Silently conflating them would trade one wrong verdict for another.
 */
export const RouteDecidedBy = {
  CHANGE: 'route-change',
  CURRENT: 'current-route',
} as const;

/** The parts of a route a predicate can be judged against, from either source. */
interface RouteReading {
  pathname: string;
  full: string;
  decidedBy: (typeof RouteDecidedBy)[keyof typeof RouteDecidedBy];
  data: Record<string, unknown>;
}

/**
 * The session's live URL, split the way a route-change event already carries it.
 *
 * Absolute (that is what the session tracks), but a relative value is accepted rather than thrown
 * away — an unreadable URL is not worth losing the fallback over.
 */
function readCurrentRoute(url: string): RouteReading {
  const parsed = URL.canParse(url) ? new URL(url) : undefined;
  const pathname = parsed?.pathname ?? url;
  const search = parsed?.search ?? '';
  const hash = parsed?.hash ?? '';
  return {
    pathname,
    full: `${pathname}${search}${hash}`,
    decidedBy: RouteDecidedBy.CURRENT,
    data: { pathname, search, hash, url, decidedBy: RouteDecidedBy.CURRENT },
  };
}

/** Name the source in the prose too — the structured `decidedBy` is for the agent, this is for a log. */
function describeRouteSource(reading: RouteReading): string {
  return reading.decidedBy === RouteDecidedBy.CHANGE
    ? 'route changed to'
    : 'current route (no route change in the window)';
}

export function evalRoute(
  events: ReticleEvent[],
  p: Extract<Predicate, { kind: typeof PredicateKind.ROUTE }>,
  /**
   * Where the app is RIGHT NOW, if the caller can say.
   *
   * Without it a route predicate could only ever be answered by a navigation inside the window, so
   * "did the session survive a reload?" — which by definition produces no route change — and "we
   * landed on /login" after a completed navigate were both a guaranteed false red, contradicted by
   * `reticle_snapshot({ mode: 'status' }).route` one call later. Optional so a caller with no session
   * (a replayed window) keeps the old answer instead of inventing a route.
   */
  currentUrl?: string,
): EvalResult {
  const routes = events.filter((e) => e.type === EventType.ROUTE_CHANGE);
  const last = routes.at(-1);
  const reading: RouteReading | undefined =
    last !== undefined
      ? (() => {
          const route = routeOfEvent(last);

          return {
            pathname: route.routePath,
            full: route.full,
            decidedBy: RouteDecidedBy.CHANGE,
            data: { ...last.data, decidedBy: RouteDecidedBy.CHANGE },
          };
        })()
      : currentUrl === undefined || 0 === currentUrl.length
        ? undefined
        : readCurrentRoute(currentUrl);
  if (reading === undefined) {
    return {
      pass: false,
      failureReason: 'no route change observed',
      observed: 'no route change in the window',
      expected: `a route change to ${p.pathname ?? p.contains ?? 'any route'}`,
      assertion: 'route.changed',
    };
  }
  const pathname = reading.pathname;
  if (p.pathname !== undefined && pathname !== p.pathname) {
    return {
      pass: false,
      failureReason: `${describeRouteSource(reading)} is '${pathname}', expected '${p.pathname}'`,
      observed: `${describeRouteSource(reading)} '${pathname}'`,
      expected: `route '${p.pathname}'`,
      assertion: 'route.pathname',
    };
  }
  // `contains` matches the WHOLE route — path + query + fragment — while `pathname` above stays an
  // exact path match. A hash router keeps the entire route in the fragment, so matching pathname
  // alone made `contains` unsatisfiable for every HashRouter app; that is the standard router for a
  // packaged Electron/Tauri renderer, where an absolute pushState would rewrite the URL to a
  // nonexistent file.
  const fullRoute = reading.full;
  if (p.contains !== undefined && !fullRoute.includes(p.contains)) {
    return {
      pass: false,
      failureReason: `${describeRouteSource(reading)} '${fullRoute}' does not contain '${p.contains}'`,
      observed: `${describeRouteSource(reading)} '${fullRoute}'`,
      expected: `a route containing '${p.contains}'`,
      assertion: 'route.contains',
    };
  }
  return { pass: true, evidence: reading.data };
}
