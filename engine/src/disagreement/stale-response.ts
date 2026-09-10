import { ContradictionKind, EventType, type ReticleEvent } from '@reticlehq/core';
import type { OwnContradiction } from './contradictions.js';

/**
 * Overlapping reads of one endpoint that settled in the WRONG ORDER.
 *
 * Reproduced deterministically on a shipments console: a filter click issues `?status=all`, a second
 * click 60ms later issues `?status=held`, the server answers `held` in 90ms and `all` in 700ms — so
 * the superseded response arrives last and overwrites the current one. The control reads "held" and
 * every row on screen is some other status. Both requests are 200, the page settles, and no channel
 * disagrees with any other. This is a false green that survives every check Reticle had.
 *
 * The evidence is the INTERLEAVING, which exists only in a request timeline. A screenshot cannot hold
 * it, a DOM snapshot cannot hold it, and by the time anyone inspects the page it is gone.
 *
 * Deliberately narrow, because a wrong accusation here is expensive:
 *
 *  - same path, DIFFERENT query — two reads of the same resource, not a retry (that is
 *    `DUPLICATE_REQUEST`) and not two unrelated endpoints.
 *  - genuinely OVERLAPPING — the second was issued before the first came back. Sequential requests
 *    that happen to arrive out of order are impossible; sequential requests are not a race.
 *  - reads only. A GET is idempotent and replaceable, so "the later one wins" is the intent. Two
 *    overlapping writes are a different (and worse) problem, reported by other rules.
 */

/** A request the SDK saw start and finish, with both times. */
interface Flight {
  id: string;
  url: string;
  method: string;
  issuedAt: number;
  settledAt: number;
}

function pathOf(url: string): string {
  const q = url.indexOf('?');
  return -1 === q ? url : url.slice(0, q);
}

function queryOf(url: string): string {
  const q = url.indexOf('?');
  return -1 === q ? '' : url.slice(q + 1);
}

/**
 * Parameters that ENUMERATE a collection rather than select within it.
 *
 * Two overlapping reads that differ only in these are a fan-out, not a race: an app fetching page 0
 * and page 5 in parallel wants both, and whichever lands last is not overwriting the other. Measured
 * against a synthetic dashboard doing parallel pagination — every run reported a race, because the
 * requests do overlap and do settle out of order, and the original rule looked no further than that.
 *
 * A filter race differs in a SELECTING parameter (`status`, `q`, a date range): the second request
 * makes the first obsolete, both answer into the same view, and the slower one wins.
 */
const ENUMERATING_PARAMS = new Set([
  'page',
  'offset',
  'cursor',
  'limit',
  'size',
  'per_page',
  'perPage',
  'pageSize',
  'after',
  'before',
  'start',
  'end',
]);

/** Whether the two queries differ ONLY in how much of the same collection they ask for. */
function differsOnlyByEnumeration(first: string, second: string): boolean {
  const a = new URLSearchParams(first);
  const b = new URLSearchParams(second);
  const keys = new Set([...a.keys(), ...b.keys()]);
  let differed = false;
  for (const key of keys) {
    if (a.get(key) === b.get(key)) continue;
    if (!ENUMERATING_PARAMS.has(key)) return false;
    differed = true;
  }
  return differed;
}

/** Pair NET_PENDING with its NET_REQUEST by the id both carry. Unpaired events are still in flight. */
function flights(events: readonly ReticleEvent[]): Flight[] {
  const issued = new Map<string, { url: string; method: string; at: number }>();
  const out: Flight[] = [];
  for (const event of events) {
    const id = 'string' === typeof event.data['id'] ? event.data['id'] : undefined;
    if (id === undefined) continue;
    const at = 'number' === typeof event.t ? event.t : 0;
    if (event.type === EventType.NET_PENDING) {
      const url = 'string' === typeof event.data['url'] ? event.data['url'] : '';
      const method = 'string' === typeof event.data['method'] ? event.data['method'] : 'GET';
      issued.set(id, { url, method, at });
      continue;
    }
    if (event.type !== EventType.NET_REQUEST) continue;
    const start = issued.get(id);
    if (start === undefined) continue; // started before this window — its ordering is unknowable
    out.push({
      id,
      url: start.url,
      method: start.method.toUpperCase(),
      issuedAt: start.at,
      settledAt: at,
    });
  }
  return out;
}

/**
 * Most recent flights compared per endpoint.
 *
 * The comparison is pairwise, so an unbounded window is quadratic: measured at 548ms for 2000
 * concurrent reads of one endpoint, paid on EVERY verdict. A verdict that costs half a second is a
 * verdict agents stop asking for. Racing requests are adjacent in time by definition, so the most
 * recent flights are where a race can be; older ones cannot overlap them anyway.
 *
 * Bounded rather than silent: this is a detection ceiling, not a truncation of reported data — a race
 * among more than this many simultaneous reads of ONE endpoint goes unreported, and that is a
 * deliberate trade for a hot path that runs on every assert.
 */
const MAX_FLIGHTS_PER_PATH = 60;

/** The one contradiction, or none. Reported once per window — a race is a fact about the window. */
/**
 * How long after a superseded response lands we look for the app reacting to it.
 *
 * A handler runs on the microtask that resolves the fetch; the render follows within a frame or two.
 * Beyond this the connection between the response and any change is speculation.
 */
const APPLY_WINDOW_MS = 500;

/**
 * How far BEFORE the completion stamp a reaction still counts as reacting to it.
 *
 * Not a fudge factor — a correction for which of the two is stamped first. `NET_REQUEST` is emitted
 * when the observer's wrapper sees the fetch settle, and the app's own handler runs on the same
 * microtask; in practice the app's state write, signal and DOM text land at or a millisecond BEFORE
 * the completion event that caused them.
 *
 * So a strictly-forward window could not see the application at all, and the rule could never fire on
 * real traffic however plainly the app misbehaved. Sixteen passing unit tests did not catch that,
 * because synthetic events are written with the reaction placed after the cause.
 */
const APPLY_SLACK_MS = 100;

/**
 * Did the app REACT to this response — did anything user-visible move after it landed?
 *
 * The question the rule could not previously ask, and the difference between a defect and a
 * correctly-handled race. An app that guards against superseded responses still RACES: two requests
 * overlap and settle out of order exactly as before. What it does not do is act on the loser.
 *
 * Without this check the rule fires identically on both, which is worse than not having it: a
 * detector that accuses correct code teaches people to ignore it, and it takes the true positives
 * down with it.
 */
function appliedAfter(events: readonly ReticleEvent[], settledAt: number): boolean {
  return events.some((event) => {
    if (event.t < settledAt - APPLY_SLACK_MS || event.t > settledAt + APPLY_WINDOW_MS) return false;
    return (
      event.type === EventType.STATE_CHANGE ||
      event.type === EventType.SIGNAL ||
      event.type === EventType.DOM_TEXT ||
      event.type === EventType.DOM_ADDED ||
      event.type === EventType.DOM_REMOVED ||
      event.type === EventType.DOM_ATTR
    );
  });
}

export function findStaleResponses(events: readonly ReticleEvent[]): OwnContradiction[] {
  // Grouped by path first: two reads of DIFFERENT endpoints can never race, and comparing them was
  // the bulk of the work on any real page, which talks to many endpoints at once.
  const byPath = new Map<string, Flight[]>();
  for (const flight of flights(events)) {
    if (flight.method !== 'GET') continue;
    const path = pathOf(flight.url);
    const group = byPath.get(path) ?? [];
    group.push(flight);
    byPath.set(path, group);
  }
  for (const group of byPath.values()) {
    const reads = group.slice(-MAX_FLIGHTS_PER_PATH);
    const found = raceIn(reads, events);
    if (found !== undefined) return [found];
  }
  return [];
}

function raceIn(
  reads: readonly Flight[],
  events: readonly ReticleEvent[],
): OwnContradiction | undefined {
  for (const first of reads) {
    for (const second of reads) {
      if (first.id === second.id) continue;
      if (second.issuedAt <= first.issuedAt) continue; // `first` must be the earlier request
      if (second.issuedAt >= first.settledAt) continue; // sequential, not overlapping
      if (second.settledAt >= first.settledAt) continue; // settled in order — no race
      if (queryOf(first.url) === queryOf(second.url)) continue; // a retry, not a superseding query
      // Parallel pagination is not a race — see differsOnlyByEnumeration.
      if (differsOnlyByEnumeration(queryOf(first.url), queryOf(second.url))) continue;
      // The race happened. Whether it MATTERS is whether the app acted on the loser — an app that
      // drops superseded responses races just as visibly and is not broken.
      if (!appliedAfter(events, first.settledAt)) continue;
      return {
        kind: ContradictionKind.STALE_RESPONSE_APPLIED,
        claim: `both reads of ${pathOf(first.url)} returned successfully and the page settled`,
        counter: `the SUPERSEDED request (${queryOf(first.url)}) settled ${String(Math.max(0, first.settledAt - second.settledAt))}ms AFTER the one that replaced it (${queryOf(second.url)}), so the screen is showing the older query's data`,
        detail:
          'a filter/search race: the newer request was issued while the older was still in flight, and the older answered last, so whichever query the server happens to be slower at wins — unless the app cancels superseded requests or drops responses that no longer match current state',
      };
    }
  }
  return undefined;
}
