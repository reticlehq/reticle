import { describe, expect, it } from 'vitest';
import { EventType, type ReticleEvent } from '@reticlehq/core';
import { filterEvents, mergeEventsBySeq } from './journal-query.js';

function evt(seq: number, over: Partial<ReticleEvent> = {}): ReticleEvent {
  return { t: seq * 10, seq, type: EventType.DOM_ADDED, sessionId: 'demo', data: {}, ...over };
}

describe('mergeEventsBySeq', () => {
  it('unions journal + buffer, dedups by seq, orders by seq', () => {
    const journal = [evt(0), evt(1), evt(2)]; // includes evicted early events
    const buffer = [evt(2), evt(3)]; // overlaps at seq 2, adds the recent tail
    const merged = mergeEventsBySeq(journal, buffer);
    expect(merged.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
  });

  it('does not lose an evicted event the buffer no longer holds', () => {
    const journal = [evt(0), evt(1)];
    const buffer = [evt(1)]; // seq 0 was evicted from memory
    expect(mergeEventsBySeq(journal, buffer).map((e) => e.seq)).toEqual([0, 1]);
  });
});

/**
 * A new connection must not inherit the previous one's timeline.
 *
 * The session id survives a reload (it lives in sessionStorage), so the journal file is REOPENED by
 * the next connection — while `seq` and `t` both restart at zero in the fresh page. Once the ring
 * buffer has evicted anything (permanent about a minute into any session) every query falls through
 * to that file, and the previous connection's tail — the events whose seq is beyond anything this
 * connection has produced — arrives carrying plausible-looking timestamps.
 *
 * Reported from the field: after an explicit `reticle_session end` and a fresh reconnect,
 * `reticle_assert` still reported contradictions from the previous session; two logins from
 * different runs were attributed to one action as a duplicate write; and a caller who passed an
 * explicit `since` cursor still received findings from before it — because `since` filters on `t`,
 * and the stale events' `t` is in the new connection's range.
 *
 * The buffer is the authority on what THIS connection has emitted: the journal is written from the
 * same stream and can only lag it, so nothing beyond the buffer's newest seq can belong here.
 */
describe('a reconnect does not inherit the previous connection journal', () => {
  it('drops journal events beyond anything this connection has produced', () => {
    const stale = [evt(40, { t: 4000 }), evt(41, { t: 4100 })]; // the previous connection tail
    const journal = [...stale, evt(0), evt(1)]; // then this connection appended its own
    const buffer = [evt(0), evt(1)];
    expect(mergeEventsBySeq(journal, buffer).map((e) => e.seq)).toEqual([0, 1]);
  });

  it('still returns this connection own evicted events', () => {
    const journal = [evt(9, { t: 900 }), evt(0), evt(1), evt(2)];
    const buffer = [evt(2)]; // 0 and 1 evicted, 9 belongs to the connection before
    expect(mergeEventsBySeq(journal, buffer).map((e) => e.seq)).toEqual([0, 1, 2]);
  });

  it('keeps everything when the buffer cannot say — an empty buffer proves nothing', () => {
    expect(mergeEventsBySeq([evt(0), evt(1)], []).map((e) => e.seq)).toEqual([0, 1]);
  });
});

describe('filterEvents', () => {
  const events = [
    evt(0, { t: 5 }),
    evt(1, { t: 20, actionId: 'a1' }),
    evt(2, { t: 40, actionId: 'a1' }),
    evt(3, { t: 60, actionId: 'a2' }),
  ];

  it('bounds by since/until inclusive on t', () => {
    expect(filterEvents(events, { since: 20, until: 40 }).map((e) => e.seq)).toEqual([1, 2]);
  });

  it('keeps only events attributed to a given action', () => {
    expect(filterEvents(events, { actionId: 'a1' }).map((e) => e.seq)).toEqual([1, 2]);
  });

  it('returns everything when unbounded', () => {
    expect(filterEvents(events, {})).toHaveLength(4);
  });
});
