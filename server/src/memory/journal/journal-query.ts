import type { ReticleEvent } from '@reticlehq/core';

/** Filter bounds for a journal-backed event query. All optional; omitted = unbounded on that axis. */
export interface EventQueryOptions {
  /** Lower time bound (inclusive), elapsed ms — the act cursor semantics of `eventsSince`. */
  since?: number | undefined;
  /** Upper time bound (inclusive), elapsed ms — the new `until` param. */
  until?: number | undefined;
  /** Keep only events attributed to this action id — answers "what did action N cause". */
  actionId?: string | undefined;
}

/**
 * Merge the durable journal's events with the ring buffer's, de-duplicated by `seq` (unique per
 * session), ordered by `seq` (falling back to `t` for any pre-2.2 event without one). Neither source is
 * a strict superset — the journal holds everything already flushed (incl. evicted), the buffer holds the
 * most-recent tail that may not be flushed yet — so the union is the complete picture.
 *
 * ...for THIS connection. The session id survives a reload (it lives in sessionStorage), so the next
 * connection reopens the same journal file while `seq` and `t` both restart at zero in the fresh
 * page. Once the buffer has evicted anything — permanent about a minute into any session — every
 * query falls through to that file and the PREVIOUS connection's tail arrives carrying timestamps
 * that look like this connection's. Field reports: contradictions from before an explicit
 * `reticle_session end`, two logins from different runs counted as one duplicate write, and findings
 * from before a `since` cursor the caller had passed explicitly (`since` filters on `t`, which is
 * exactly the field that restarted).
 *
 * The buffer is the authority on what this connection has emitted: the journal is written from the
 * same stream and can only lag it, so nothing beyond the buffer's newest seq can belong here.
 * Overlapping seqs need no rule — appends are ordered, so the newest write already wins the dedupe.
 */
export function mergeEventsBySeq(
  journal: readonly ReticleEvent[],
  buffer: readonly ReticleEvent[],
): ReticleEvent[] {
  // ponytail: an EMPTY buffer cannot say where this connection has got to, so nothing is dropped
  // there — a fresh connection emits page-health immediately, so the window is small and the safe
  // direction is keeping evidence rather than inventing a boundary.
  let newest: number | undefined;
  for (const event of buffer) {
    if ('number' === typeof event.seq && (newest === undefined || event.seq > newest)) {
      newest = event.seq;
    }
  }
  const bySeq = new Map<number, ReticleEvent>();
  const noSeq: ReticleEvent[] = [];
  for (const event of [...journal, ...buffer]) {
    if ('number' !== typeof event.seq) {
      noSeq.push(event);
      continue;
    }
    if (newest !== undefined && event.seq > newest) continue;
    bySeq.set(event.seq, event);
  }
  return [...bySeq.values(), ...noSeq].sort((a, b) => {
    if (a.seq !== undefined && b.seq !== undefined) return a.seq - b.seq;
    return a.t - b.t;
  });
}

/** Apply since/until/actionId bounds to an event list. */
export function filterEvents(
  events: readonly ReticleEvent[],
  options: EventQueryOptions,
): ReticleEvent[] {
  return events.filter(
    (event) =>
      (options.since === undefined || event.t >= options.since) &&
      (options.until === undefined || event.t <= options.until) &&
      (options.actionId === undefined || event.actionId === options.actionId),
  );
}
