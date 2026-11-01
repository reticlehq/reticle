/**
 * One click that loads two panels is one intent, not a race.
 *
 * From a field session on 3.9.0: an agent clicked a nav link with `reticle_act_and_wait`, and the new
 * page fetched one path twice in parallel, `?businessType=HAIR_MAKEUP` and `?businessType=PHOTO_STUDIO`,
 * one request per panel. The first settled about 100ms after the second, and the window got a false
 * `no` with `stale-response-applied`. Both answers were wanted: neither request replaced the other.
 *
 * A superseding race needs a second intent (a later click, a new filter, more keystrokes) issued while
 * the first read is in flight. A window opened by ONE discrete action, with every read issued after it,
 * holds no second intent. Text entry is different: each keystroke of `type` can issue a read that
 * replaces the last, so it keeps the rule, as does a window with no action at all.
 *
 * Known blind spot: one click whose effect fetches with a stale dependency and then with the fresh one
 * is also one intent, so it is no longer reported here.
 */
import { describe, expect, it } from 'vitest';
import { ContradictionKind, EventType, type ReticleEvent } from '@reticlehq/core';
import { findContradictions } from './contradictions.js';

const pending = (t: number, url: string, id: string): ReticleEvent => ({
  t,
  seq: t,
  type: EventType.NET_PENDING,
  sessionId: 's',
  data: { id, url, method: 'GET' },
});
const settled = (t: number, id: string, url: string): ReticleEvent => ({
  t,
  seq: t,
  type: EventType.NET_REQUEST,
  sessionId: 's',
  data: { id, url, method: 'GET', status: 200, ok: true },
});
const applied = (t: number): ReticleEvent => ({
  t,
  seq: t,
  type: EventType.STATE_CHANGE,
  sessionId: 's',
  data: { store: 'listings' },
});

const A = '/api/listings?businessType=HAIR_MAKEUP';
const B = '/api/listings?businessType=PHOTO_STUDIO';

/** Two parallel reads of one path, 20ms apart, the first settling ~100ms after the second. */
const fanOut = (): ReticleEvent[] => [
  pending(100, A, 'a'),
  pending(120, B, 'b'),
  settled(400, 'b', B),
  settled(500, 'a', A),
  applied(500),
];

const stale = (action: string | undefined): boolean =>
  findContradictions(fanOut(), {
    ...(action === undefined ? {} : { action }),
    actionSince: 0,
  }).some((c) => ContradictionKind.STALE_RESPONSE_APPLIED === c.kind);

describe('reads issued after one discrete action', () => {
  it.each(['click', 'dblclick', 'select', 'check', 'uncheck', 'submit'])(
    'a %s that loads two panels is not a stale-response race',
    (action) => {
      expect(stale(action)).toBe(false);
    },
  );
});

describe('what keeps the race rule', () => {
  it('text entry, whose keystrokes can each replace the last read', () => {
    expect(stale('type')).toBe(true);
  });

  it('a window opened by no action', () => {
    expect(stale(undefined)).toBe(true);
  });
});
