/**
 * The `route` oracle. Split out of predicate-eval.ts, which was at the file-size backstop.
 *
 * Route is the one predicate with TWO sources of truth — a navigation inside the window and where the
 * app is right now — and keeping that reconciliation in one place is what makes it readable.
 */
import { EventType, PredicateKind, RETICLE_URL_PARAM, type ReticleEvent } from '@reticlehq/core';
import { str, type EvalResult, type Predicate } from './predicate-eval.js';

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
  /** The path the ROUTER is on: the fragment's path under a hash router, else the document path. */
  routePath: string;
  full: string;
  decidedBy: (typeof RouteDecidedBy)[keyof typeof RouteDecidedBy];
  data: Record<string, unknown>;
}

/**
 * The path the router is actually on.
 *
 * Under a hash router the document pathname is `/` on every page and the whole route lives in the
 * fragment — which is why `contains` below matches the full route. `pathname` was left comparing the
 * document path, so `{ pathname: '/posts/12/show' }` could never pass on a HashRouter app, the
 * standard router for a packaged Electron/Tauri renderer. That is a guaranteed false red: Reticle
 * telling a user their working app is broken.
 *
 * The fragment WINS rather than being accepted alongside the document path. Honouring both would
 * make `{ pathname: '/' }` trivially true on every hash-routed page — a green that says nothing
 * about where the app is, which is the failure this predicate exists to prevent.
 */
export function routePathOf(pathname: string, hash: string): string {
  if (!hash.startsWith('#/')) return pathname;
  const withoutHash = hash.slice(1);
  const query = withoutHash.indexOf('?');
  return -1 === query ? withoutHash : withoutHash.slice(0, query);
}

/**
 * The resolved parts of a route, from a `ROUTE_CHANGE` event or a session URL.
 *
 * `routePath` is where the ROUTER is (the fragment path under a hash router). `docPath` + `hash`
 * is the NAVIGABLE value a `reticle_navigate` can be pointed at. Call sites pick; collapsing
 * them into one string is how a hash-router miss lands as "every page is `/`".
 */
export interface RouteParts {
  routePath: string;
  docPath: string;
  hash: string;
  search: string;
  full: string;
}

function asPayload(value: unknown): Record<string, unknown> | undefined {
  if (null === value || 'object' !== typeof value || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function payloadOf(
  eventOrData: ReticleEvent | Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (eventOrData['type'] === EventType.ROUTE_CHANGE) return asPayload(eventOrData['data']);
  // A different event: refuse rather than read whatever happened to sit in `data`.
  if (undefined !== eventOrData['type'] && undefined !== eventOrData['data']) return undefined;
  return eventOrData;
}

function partsFromPayload(data: Record<string, unknown>): RouteParts | undefined {
  const docPath = str(data['pathname']) ?? str(data['to']);
  if (docPath === undefined) return undefined;
  const hash = str(data['hash']) ?? '';
  const search = str(data['search']) ?? '';
  return {
    routePath: routePathOf(docPath, hash),
    docPath,
    hash,
    search,
    full: `${docPath}${search}${hash}`,
  };
}

/** A `ROUTE_CHANGE` event, or its `data` — one reading, so the sixth copy cannot drift. */
export function routeOfEvent(
  eventOrData: ReticleEvent | Record<string, unknown>,
): RouteParts | undefined {
  const data = payloadOf(eventOrData);
  return data === undefined ? undefined : partsFromPayload(data);
}

/**
 * Route evidence with Reticle's OWN identity params removed.
 *
 * A leased tab carries `__reticle_session` (and optionally `__reticle_project`) because the pool
 * appended them so the app's SDK would adopt the lease — they are Reticle's bookkeeping, not the
 * app's state. Reporting them back is paying tokens to tell ourselves something we wrote: measured
 * on a real drive, `from`, `to` and `search` each echoed the same lease UUID, 58 of the evidence
 * block's 96 tokens for one value stated three times.
 *
 * Only OUR params are dropped. The app's own query string is evidence — a redirect that loses one
 * is exactly what a route assertion is for — so everything else survives, and a URL that will not
 * parse is returned untouched rather than lost.
 */
function withoutIdentityParams(value: unknown): unknown {
  if ('string' !== typeof value) return value;
  const isSearch = value.startsWith('?');
  if (isSearch) {
    const params = new URLSearchParams(value);
    for (const name of Object.values(RETICLE_URL_PARAM)) params.delete(name);
    const rest = params.toString();
    return 0 === rest.length ? '' : `?${rest}`;
  }
  if (!URL.canParse(value)) return value;
  const parsed = new URL(value);
  for (const name of Object.values(RETICLE_URL_PARAM)) parsed.searchParams.delete(name);
  return parsed.toString();
}

/** The event payload as evidence: every URL-ish field scrubbed of our own params. */
function routeEvidence(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => [key, withoutIdentityParams(value)]),
  );
}

/** Same shape from a session URL (the fallback when the tab hard-loaded and emitted no route event). */
export function routeOfUrl(url: string): RouteParts | undefined {
  if (!URL.canParse(url)) return undefined;
  const parsed = new URL(url);
  return partsFromPayload({
    pathname: parsed.pathname,
    search: parsed.search,
    hash: parsed.hash,
  });
}

/**
 * The session's live URL, split the way a route-change event already carries it.
 *
 * Absolute (that is what the session tracks), but a relative value is accepted rather than thrown
 * away — an unreadable URL is not worth losing the fallback over.
 */
function readCurrentRoute(url: string): RouteReading {
  const parts = routeOfUrl(url);
  const pathname = parts?.docPath ?? url;
  const search = parts?.search ?? '';
  const hash = parts?.hash ?? '';
  return {
    pathname,
    routePath: parts?.routePath ?? routePathOf(pathname, hash),
    full: parts?.full ?? `${pathname}${search}${hash}`,
    decidedBy: RouteDecidedBy.CURRENT,
    data: routeEvidence({ pathname, search, hash, url, decidedBy: RouteDecidedBy.CURRENT }),
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
  /** Event-time floor for the window, so a request already in flight before it is not counted. */
  since = 0,
): EvalResult {
  const routes = events.filter((e) => e.type === EventType.ROUTE_CHANGE);
  const last = routes.at(-1);
  const changed = last === undefined ? undefined : routeOfEvent(last);
  const reading: RouteReading | undefined =
    changed !== undefined && last !== undefined
      ? {
          pathname: changed.docPath,
          routePath: changed.routePath,
          full: changed.full,
          decidedBy: RouteDecidedBy.CHANGE,
          data: routeEvidence({ ...last.data, decidedBy: RouteDecidedBy.CHANGE }),
        }
      : currentUrl === undefined || 0 === currentUrl.length
        ? undefined
        : readCurrentRoute(currentUrl);
  if (reading === undefined) {
    // A navigation the SERVER never answered reads exactly like one the APP prevented, and only one
    // of those is the user's bug. See unansweredIn.
    const unanswered = unansweredIn(events, since);
    if (unanswered !== undefined) {
      const reason =
        `no route change, and ${unanswered.count} request(s) started in this window never ` +
        `completed — first: ${unanswered.method} ${unanswered.url}. A navigation the server has ` +
        'not answered is indistinguishable from one the app declined, so this is not evidence ' +
        'against the app. Check the server directly (curl the route) before looking at components';
      return {
        pass: false,
        failureReason: reason,
        inconclusive: reason,
        observed: `${unanswered.count} request(s) still in flight, no route change`,
        expected: `a route change to ${p.pathname ?? p.contains ?? 'any route'}`,
        assertion: 'route.server-pending',
      };
    }
    return {
      pass: false,
      failureReason: 'no route change observed',
      observed: 'no route change in the window',
      expected: `a route change to ${p.pathname ?? p.contains ?? 'any route'}`,
      assertion: 'route.changed',
    };
  }
  // The ROUTER's path, not the document's — see routeOfEvent.
  const pathname = reading.routePath;
  if (p.pathname !== undefined && pathname !== p.pathname) {
    return {
      pass: false,
      // No ` is` after the clause: it read "route changed to is '/'".
      failureReason: `${describeRouteSource(reading)} '${pathname}', expected '${p.pathname}'`,
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
  return {
    pass: true,
    evidence:
      reading.decidedBy === RouteDecidedBy.CHANGE
        ? { ...reading.data, viewSettled: sawActivityAfter(events, last?.t ?? 0) }
        : reading.data,
  };
}

/**
 * Did the page do ANYTHING after the URL moved?
 *
 * A route predicate goes green the instant the URL commits, and on an async-loading page that is a
 * verdict taken over a shell. The reporter's sequence is the whole argument: `allOf [route, console
 * absent]` returned `verified: "yes"`, a snapshot of `main` came back with 9 nodes that read as an
 * empty page, and re-snapshotting moments later showed 22 with the real content — one step from
 * filing "this route renders nothing" against code that was fine.
 *
 * The grade is deliberately NOT changed. Requiring a settle would make every route assertion wait
 * and would flip green suites red, and the report's own acceptance allows either that or evidence
 * saying the view had not settled. This is the second, and it costs nothing that already worked.
 *
 * No clock is read: if the route change is the LAST thing in the window, nothing has been observed
 * since the URL moved, which is exactly the trap. Activity BEFORE the change is ignored — a mutation
 * that predates the navigation says nothing about what the new route rendered.
 *
 * Reported only for a CHANGE reading. A pass decided by "the app is already there" has no commit
 * moment to be too close to, and a caveat there would describe a reading it is not about.
 */
function sawActivityAfter(events: readonly ReticleEvent[], routeAt: number): boolean {
  return events.some((e) => e.t > routeAt && ROUTE_SETTLE_ACTIVITY.has(e.type));
}

/**
 * What counts as the view still moving. Same set the `settled` oracle uses, and deliberately the
 * same one: two different answers to "did the page do something" is how a vocabulary rots.
 */
const ROUTE_SETTLE_ACTIVITY: ReadonlySet<EventType> = new Set([
  EventType.NET_REQUEST,
  EventType.DOM_ADDED,
  EventType.DOM_REMOVED,
  EventType.DOM_ATTR,
]);

/**
 * A request that STARTED in this window and never completed.
 *
 * The discriminator the route oracle was missing. `routeChanges: 0, network: 0` is reported the same
 * way whether the app prevented the navigation or the server never answered the request the app
 * made — and only the first is the user's bug. Reticle already saw the pending navigation; it just
 * never said so, and attached a `source:` file:line that pointed at innocent code.
 *
 * Scoped to requests that started INSIDE the window, deliberately. A background poll that predates
 * the action says nothing about this navigation, and counting it would make every route miss on a
 * polling app inconclusive — softening away the finding this oracle exists to make. That is the same
 * trap the duplicate-request and contradiction rules were each narrowed to avoid.
 *
 * Matched on the request id, the way `detectHungRequests` does: a NET_PENDING with no NET_REQUEST
 * carrying the same id.
 */
function unansweredIn(
  events: readonly ReticleEvent[],
  since: number,
): { count: number; url: string; method: string } | undefined {
  const settled = new Set<unknown>();
  for (const e of events) if (e.type === EventType.NET_REQUEST) settled.add(e.data['id']);
  const open = events.filter(
    (e) => e.type === EventType.NET_PENDING && e.t >= since && !settled.has(e.data['id']),
  );
  const first = open[0];
  if (first === undefined) return undefined;
  return {
    count: open.length,
    url: str(first.data['url']) ?? '(unknown url)',
    method: str(first.data['method']) ?? 'GET',
  };
}
