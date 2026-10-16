/**
 * #1259: a zero-match find read while the last act is still landing says so.
 *
 * Click a control that opens a modal after a fetch, then immediately find the modal's combobox: 0.
 * The read is a point in time, and the render had not landed. These pin when `unsettled` is added
 * (a request the act started is still out, or the DOM moved under `UNSETTLED_DOM_QUIET_MS` ago) and
 * when it is not (a match, a quiet window, no act at all).
 */
import { describe, expect, it } from 'vitest';
import { EventType, type ReticleEvent } from '@reticlehq/core';
import {
  UNSETTLED_DOM_QUIET_MS,
  unsettledFind,
  withUnsettledFind,
  type UnsettledFindSession,
} from './unsettled-find.js';

let seq = 0;
function ev(type: EventType, t: number, data: Record<string, unknown> = {}): ReticleEvent {
  seq += 1;
  return { t, seq, type, sessionId: 's', data };
}

function session(
  events: ReticleEvent[],
  now: number,
  cursor: number | null = 100,
): UnsettledFindSession {
  return {
    lastAct: { cursor: () => cursor ?? undefined },
    eventsSince: (c) => events.filter((e) => e.t >= c),
    elapsed: () => now,
    url: 'http://localhost:5173/',
    background: [],
  };
}

const ZERO = { elements: [], count: 0 };
const pending = (t: number): ReticleEvent =>
  ev(EventType.NET_PENDING, t, {
    id: 'r1',
    method: 'GET',
    url: 'http://localhost:5173/api/options',
  });

describe('a zero-match read mid-render', () => {
  it('names the request the act started that has not come back', () => {
    const u = unsettledFind(session([pending(110)], 400), ZERO);
    expect(u?.inFlight).toEqual(['GET http://localhost:5173/api/options']);
    expect(u?.reason).toContain('reticle_assert { action: "wait"');
  });

  it('names a DOM change under the quiet window', () => {
    const u = unsettledFind(
      session([ev(EventType.DOM_ADDED, 300)], 300 + UNSETTLED_DOM_QUIET_MS - 1),
      ZERO,
    );
    expect(u?.lastDomChangeMsAgo).toBe(UNSETTLED_DOM_QUIET_MS - 1);
    expect(u?.reason).toContain('changed');
  });

  it('applies to a count_only answer too', () => {
    expect(unsettledFind(session([pending(110)], 400), { count: 0 })).toBeDefined();
  });

  it('is attached to the result, keeping every field', () => {
    const out = withUnsettledFind(session([pending(110)], 400), { ...ZERO, hint: { route: '/' } });
    expect(out).toMatchObject({ count: 0, hint: { route: '/' } });
    expect((out as { unsettled?: { reason?: unknown } }).unsettled?.reason).toContain(
      'still changing',
    );
  });
});

describe('what stays as it was', () => {
  it('a match is never annotated', () => {
    expect(
      unsettledFind(session([pending(110)], 400), { count: 1, elements: [{}] }),
    ).toBeUndefined();
  });

  it('a quiet window: the last DOM change is at least the quiet period old, nothing in flight', () => {
    const quiet = session([ev(EventType.DOM_ADDED, 300)], 300 + UNSETTLED_DOM_QUIET_MS);
    expect(unsettledFind(quiet, ZERO)).toBeUndefined();
  });

  it('a request that came back is not in flight', () => {
    const answered = ev(EventType.NET_REQUEST, 120, {
      id: 'r1',
      method: 'GET',
      url: 'http://localhost:5173/api/options',
      status: 200,
    });
    expect(unsettledFind(session([pending(110), answered], 5000), ZERO)).toBeUndefined();
  });

  it('no act yet: there is no window to judge', () => {
    expect(unsettledFind(session([pending(110)], 400, null), ZERO)).toBeUndefined();
  });

  it('activity before the last act does not count', () => {
    expect(unsettledFind(session([pending(50)], 400, 100), ZERO)).toBeUndefined();
  });

  it('a result that is not a query result passes through untouched', () => {
    expect(withUnsettledFind(session([pending(110)], 400), 'text')).toBe('text');
  });

  it('a session that cannot say what its last act was gets the read unchanged', () => {
    const bare = { url: '', background: [] } as unknown as UnsettledFindSession;
    expect(withUnsettledFind(bare, ZERO)).toBe(ZERO);
  });
});
