/**
 * A `net` clause that missed because the request it names WAS the document navigation.
 *
 * On a server-rendered app -- Django, Rails, Laravel, plain HTML, and any Next.js or Astro route
 * that falls back to a full load -- clicking a link fetches a new document. The SDK tears down with
 * the old document and reconnects on the new one, so the navigation request is never in the
 * post-reconnect buffer. From the field, on a Django MPA:
 *
 *     reticle_act_and_wait on http://127.0.0.1:8000/cloud/
 *     -> route + heading PASSED (landed on /openworker/)
 *        net GET /openworker/ MISSED
 *
 * The route clause proved the app arrived. The net clause is unanswerable by construction: not
 * because the request did not happen -- it demonstrably did, the page is the response -- but
 * because the observer that would have recorded it did not exist yet. Graded as an ordinary miss it
 * reads as "the request never fired", which is a claim about the app, and the honest cost is an
 * agent that starts dropping net checks because they lie on this rendering model (#898).
 *
 * The signature is exact and needs no cross-document state:
 *
 *  - the clause's `urlContains` matches where the session IS now, and
 *  - nothing in the window emitted a route change.
 *
 * Both halves are load-bearing. Without the first, every net miss on a page that happened to reload
 * would be excused. Without the second, a client-side route change to the same path -- where the
 * request WAS observable and genuinely absent -- would be excused too, and that is the finding this
 * oracle exists to make. `evalRoute` already reads the same pair, calling it
 * `RouteDecidedBy.CURRENT`; this is the net-channel half of the same fact.
 */

import { EventType } from '@reticlehq/core';
import type { ReticleEvent } from '@reticlehq/core';

/** The narrow slice of a net predicate this check reads. */
interface NetClause {
  urlContains?: string;
  method?: string;
}

/** The path and search of a URL, or the raw string when it will not parse. */
function documentPathOf(url: string): string {
  if (!URL.canParse(url)) return url;
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
}

/**
 * True when this miss is the document navigation itself, rather than a request that never fired.
 *
 * A clause with no `urlContains` is not covered: it names no URL, so nothing here can say the
 * document was what it meant. A GET (or an unstated method) only -- a document navigation from a
 * link is a GET, and a POST-then-redirect names the POST, which the old document DID observe.
 */
export function missedTheDocumentNavigation(
  events: readonly ReticleEvent[],
  clause: NetClause,
  currentUrl: string | undefined,
): boolean {
  const wanted = clause.urlContains;
  if (wanted === undefined || 0 === wanted.length) return false;
  if (clause.method !== undefined && 'GET' !== clause.method.toUpperCase()) return false;
  if (currentUrl === undefined || 0 === currentUrl.length) return false;
  if (!documentPathOf(currentUrl).includes(wanted)) return false;
  return !events.some((event) => event.type === EventType.ROUTE_CHANGE);
}

/** The sentence that replaces "no network call matched", naming the blind spot and its cause. */
export function documentNavigationReason(clause: NetClause, currentUrl: string): string {
  const path = documentPathOf(currentUrl);
  const method = clause.method === undefined ? 'GET' : clause.method.toUpperCase();
  return (
    `the session is on ${path} and no route change was observed, so this was a FULL DOCUMENT ` +
    `navigation: the SDK tore down with the old document and reconnected on the new one, and the ` +
    `${method} that fetched it is not in this window. That is a blind spot, not evidence the ` +
    `request never happened -- the page you are on IS the response. The route and the rendered ` +
    `content are observable here and are what to assert on; a net clause naming the document URL ` +
    `cannot be answered on a server-rendered navigation`
  );
}
