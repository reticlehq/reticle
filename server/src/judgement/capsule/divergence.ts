import { ConsequenceKind, EventType, type ExpectedLink, type ReticleEvent } from '@reticlehq/core';

/**
 * First-divergence — the brain of the divergence capsule (Tier 2). Given the chain the flow DECLARED
 * should happen (its mustHold, as ordered expected links) and what was OBSERVED, walk the declaration and
 * report the FIRST link where expected ≠ observed, values side by side. That single link is where the
 * fault lives — the agent fixes it without re-exploring. Pure; the acceptance bar is that for every
 * hidden-500 / hung-request fixture it names the correct link.
 */

/**
 * The links a capsule can walk. Defined in the shared vocabulary, because the rules that decide a
 * verdict produce this shape and the explanation of a red verdict consumes it, and neither should
 * have to reach into the other to name the same thing. Re-exported here so the places that already
 * read it from this file still can.
 */
export type { ExpectedLink };

export interface Divergence {
  /** The declared link that did not hold. */
  expected: ExpectedLink;
  /** Human description of what was observed instead (the closest attempt, or "nothing"). */
  observed: string;
}

function net(events: readonly ReticleEvent[]): ReticleEvent[] {
  return events.filter((e) => e.type === EventType.NET_REQUEST);
}

function satisfies(link: ExpectedLink, events: readonly ReticleEvent[]): boolean {
  switch (link.kind) {
    case ConsequenceKind.SIGNAL:
      return events.some((e) => e.type === EventType.SIGNAL && e.data['name'] === link.name);
    case ConsequenceKind.STATE:
      // Matched against the store name OR the changed path, because the link carries whichever half
      // the predicate gave: `store` when it named one, and `path` otherwise (predicateToExpectedLinks).
      // The event carries both. Comparing only the store meant every assertion written by path
      // reported "never changed" however the app behaved — a false claim printed beside a `stateDiffs`
      // entry showing that exact path changing.
      return events.some(
        (e) =>
          e.type === EventType.STATE_CHANGE &&
          (e.data['name'] === link.name || e.data['path'] === link.name),
      );
    case ConsequenceKind.NET:
      return net(events).some(
        (e) =>
          'string' === typeof e.data['url'] &&
          e.data['url'].includes(link.urlContains) &&
          (link.status === undefined || e.data['status'] === link.status),
      );
  }
}

/**
 * Describe what WAS observed for a link that failed — the closest attempt, for a side-by-side.
 *
 * `truncated` says the buffer dropped events belonging to this window, which turns every sentence
 * below from a claim about the app into a claim about a partial reading. It is the difference
 * between "the request was never made" and "no surviving event shows the request", and a field
 * session proved they are not interchangeable: a POST that returned 200 inside the window carried
 * the whole root cause, and the capsule for that same window said `state "cad" never changed`. The
 * agent believed the absolute — the strongest, most specific, and most wrong thing this tool can
 * say. Absence of evidence must never be typed as evidence of absence.
 */
function observedFor(
  link: ExpectedLink,
  events: readonly ReticleEvent[],
  truncated: boolean,
): string {
  if (ConsequenceKind.NET === link.kind) {
    const match = net(events).find(
      (e) => 'string' === typeof e.data['url'] && e.data['url'].includes(link.urlContains),
    );
    if (match !== undefined) {
      return `${link.urlContains} responded ${String(match.data['status'])} (expected ${String(link.status)})`;
    }
    return truncated
      ? `no surviving event shows a request to ${link.urlContains} — capture truncated, so this is not evidence there was none`
      : `no request to ${link.urlContains}`;
  }
  const subject =
    ConsequenceKind.SIGNAL === link.kind ? `signal "${link.name}"` : `state "${link.name}"`;
  if (truncated) return `${subject} was not observed — capture truncated, so absence is unproven`;
  return ConsequenceKind.SIGNAL === link.kind
    ? `${subject} never fired`
    : `${subject} never changed`;
}

/**
 * Walk the declared chain in order; return the first link not satisfied by the observed events (with a
 * side-by-side of what happened instead), or null when the whole chain held.
 */
export function firstDivergence(
  expected: readonly ExpectedLink[],
  observed: readonly ReticleEvent[],
  truncated = false,
): Divergence | null {
  for (const link of expected) {
    if (!satisfies(link, observed)) {
      return { expected: link, observed: observedFor(link, observed, truncated) };
    }
  }
  return null;
}
