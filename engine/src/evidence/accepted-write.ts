import {
  ConsequenceKind,
  EventType,
  HTTP_ACCEPTED,
  MUTATING_METHODS,
  isDevToolingUrl,
  isForeignTraffic,
  urlForMatch,
  type ExpectedLink,
  type ReticleEvent,
} from '@reticlehq/core';
import { asNumber, asString } from '@reticlehq/core';

/**
 * Did a write in this window answer `202 Accepted`?
 *
 * `202` is the only status in HTTP whose meaning is "no outcome yet" — the server took the request
 * and has not finished with it. Folding it into the 2xx success band is how an asynchronous workflow
 * gets a green verdict at exactly the moment nothing has been decided.
 *
 * Measured on a logistics console with server-side reconciliation: a dispatch answered 202, the row
 * optimistically rendered "dispatched", the page settled, every channel agreed — and the server
 * REVERTED it to `held` 1.2 s later. The verdict was not wrong about what it observed. It was early,
 * and nothing in the response said so except the status code nobody was reading.
 *
 * The DEV TOOLCHAIN's own traffic is excluded, on the same rule every other check applies: a verdict
 * about the app must not be decided by a request the app did not make.
 */
/**
 * What the caller knows about the claim, which a bare window scan cannot (#1120).
 *
 * The rule is right for the write the claim depends on and wrong for everything else that answered
 * 202 in the same window. An analytics beacon made every verdict in the app `unknown`, and a claim
 * that deliberately asserted "the POST returned 202 and accepted: true" could not say so. The
 * filter lives here, at the evidence boundary, so both callers inherit it.
 *
 * Every field is optional: a caller with no page URL, no declared background and no proven links
 * gets exactly the behaviour this function had before, which the older unit tests pin.
 */
export interface AcceptedWriteFilter {
  /** The page under test. A 202 from another origin is not its outcome. */
  readonly appUrl?: string | undefined;
  /** Endpoints the project declared as background; their 202s are a heartbeat, not the action. */
  readonly background?: readonly string[] | undefined;
  /**
   * The NET links the claim actually PROVED, from a green verdict only. A 202 a link names with
   * `status: 202` is the claim's own acceptance: it held, and the global rule must not override it.
   * On `anyOf` the proven list carries only the branch that won — a static scan of the predicate
   * could exempt a 202 the verdict never rested on.
   */
  readonly asserted?: readonly ExpectedLink[] | undefined;
}
/**
 * Which writes in this window answered `202 Accepted`, as "METHOD url".
 *
 * The verdict tells the agent to re-check once the server reconciles. That instruction is only
 * usable if the agent knows WHAT to re-check: a window with three requests and a verdict saying
 * "a write returned 202" leaves it guessing which one, and guessing wrong means watching a request
 * that already finished while the real one is still pending.
 *
 * Duplicates are folded, so a retried request names its endpoint once instead of filling the
 * sentence with the same line three times.
 */
export function acceptedWriteLabels(
  events: readonly ReticleEvent[],
  filter: AcceptedWriteFilter = {},
): string[] {
  const labels: string[] = [];
  for (const event of events) {
    if (event.type !== EventType.NET_REQUEST) continue;
    if (asNumber(event.data['status']) !== HTTP_ACCEPTED) continue;
    const method = (
      'string' === typeof event.data['method'] ? event.data['method'] : ''
    ).toUpperCase();
    // A read has no outcome to reconcile: a 202 on one is a poll or a prefetch.
    if (!MUTATING_METHODS.includes(method)) continue;
    const url = asString(event.data['url']);
    if (isDevToolingUrl(url)) continue;
    // The same split `splitForeignTraffic` makes for every other rule: somebody else's origin, or
    // an endpoint the project itself declared as background, is not the app's work under test.
    if (isForeignTraffic(url, filter.appUrl, filter.background ?? [])) continue;
    if (isAssertedAcceptance(method, urlForMatch(event.data), filter.asserted)) continue;
    const label = `${method} ${url ?? ''}`.trim();
    if ('' !== label && !labels.includes(label)) labels.push(label);
  }
  return labels;
}

/**
 * Did the claim's OWN proven evidence settle this exact request?
 *
 * For the request to be exempt, EVERY proven link that names it must assert `status: 202`. One link
 * that names the same URL with another status — a 200 branch of an `anyOf` that also held, or a
 * presence-only clause — means the verdict could have been green without this acceptance, and the
 * accepted write's outcome is still owed. Method is matched when the link carries one, so a claim
 * about `GET /save` cannot exempt the pending `POST /save`.
 *
 * `urlForMatch` and not `url`: a predicate matches the raw path, and redaction rewrites some public
 * REST paths, so matching the displayed URL would drop the exemption for exactly the calls a
 * predicate can still name.
 */
function isAssertedAcceptance(
  method: string,
  url: string,
  asserted: readonly ExpectedLink[] | undefined,
): boolean {
  if (asserted === undefined) return false;
  const naming = asserted.filter(
    (link) =>
      ConsequenceKind.NET === link.kind &&
      link.urlContains !== undefined &&
      url.includes(link.urlContains) &&
      (link.method === undefined || link.method.toUpperCase() === method),
  );
  return (
    naming.length > 0 &&
    naming.every((link) => ConsequenceKind.NET === link.kind && HTTP_ACCEPTED === link.status)
  );
}

/**
 * Did a write in this window answer `202 Accepted`?
 *
 * Derived from the labels above rather than repeating the filter, so the question and the list can
 * never disagree about which requests count.
 */
export function hasAcceptedWrite(events: readonly ReticleEvent[]): boolean {
  return acceptedWriteLabels(events).length > 0;
}
