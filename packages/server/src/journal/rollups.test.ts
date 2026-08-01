import { describe, expect, it } from 'vitest';
import { EventAttribution, EventType, type ReticleEvent } from '@reticlehq/core';
import { computeSegments } from './rollups.js';

let seq = 0;
function e(type: EventType, over: Partial<ReticleEvent> = {}): ReticleEvent {
  seq += 1;
  return { t: seq, seq, type, sessionId: 'demo', data: {}, ...over };
}
function route(pathname: string): ReticleEvent {
  return e(EventType.ROUTE_CHANGE, {
    data: { from: '', to: pathname, pathname, search: '', hash: '' },
  });
}
function net(status: number, ok: boolean): ReticleEvent {
  return e(EventType.NET_REQUEST, {
    data: { id: 'r', method: 'GET', url: '/x', status, ok, durationMs: 1, initiator: 'fetch' },
  });
}

describe('computeSegments', () => {
  it('splits the event stream into segments at each route change', () => {
    const events = [net(200, true), route('/b'), net(500, false), route('/c')];
    const segs = computeSegments(events);
    expect(segs).toHaveLength(3); // initial, /b, /c
    expect(segs[1]?.route).toBe('/b');
    expect(segs[2]?.route).toBe('/c');
  });

  it('counts network totals and errors per segment', () => {
    const events = [net(200, true), net(500, false), route('/b'), net(404, false)];
    const segs = computeSegments(events);
    expect(segs[0]?.net).toEqual({ total: 2, errors: 1 });
    expect(segs[1]?.net).toEqual({ total: 1, errors: 1 });
  });

  it('counts console + uncaught errors and collects changed state paths', () => {
    const events = [
      e(EventType.CONSOLE_ERROR, { data: { message: 'boom' } }),
      e(EventType.ERROR_UNCAUGHT, { data: { message: 'nope' } }),
      e(EventType.STATE_CHANGE, { data: { name: 'cart.count', value: 1 } }),
      e(EventType.STATE_CHANGE, { data: { name: 'cart.count', value: 2 } }),
    ];
    const seg = computeSegments(events)[0];
    expect(seg?.consoleErrors).toBe(2);
    expect(seg?.statePathsChanged).toEqual(['cart.count']);
  });

  it('counts distinct attributed actions and the segment duration', () => {
    const events = [
      e(EventType.DOM_ADDED, { t: 10, actionId: 'a1', attribution: EventAttribution.WINDOW }),
      e(EventType.DOM_ADDED, { t: 20, actionId: 'a1', attribution: EventAttribution.WINDOW }),
      e(EventType.DOM_ADDED, { t: 40, actionId: 'a2', attribution: EventAttribution.WINDOW }),
    ];
    const seg = computeSegments(events)[0];
    expect(seg?.actions).toBe(2);
    expect(seg?.durationMs).toBe(30); // 40 - 10
  });

  it('counts WS/SSE stream frames by direction, omitting the field when there are none', () => {
    const stream = (direction: string): ReticleEvent =>
      e(EventType.NET_STREAM, { data: { transport: 'ws', direction, url: '/ws' } });
    const segs = computeSegments([stream('open'), stream('in'), stream('in'), stream('out')]);
    expect(segs[0]?.streams).toEqual({ frames: 4, opened: 1, in: 2, out: 1 });
    // a segment with no stream activity omits the field entirely
    expect(computeSegments([e(EventType.DOM_ADDED)])[0]?.streams).toBeUndefined();
  });

  it('marks a segment truncated when a cap dropped events in it', () => {
    const truncated = e(EventType.TRUNCATED, { data: { channel: 'dom', dropped: 500 } });
    const segs = computeSegments([e(EventType.DOM_ADDED), truncated]);
    expect(segs[0]?.truncated).toBe(true);
    // a clean segment omits the flag
    expect(computeSegments([e(EventType.DOM_ADDED)])[0]?.truncated).toBeUndefined();
  });

  it('marks a segment truncated when the browser transport dropped events in it', () => {
    // A bridge outage overflows the SDK's offline queue. The surviving counts understate reality by
    // however many events the queue swallowed, so the segment must not be read as a clean sample —
    // the deviation judge skips it, and the learned envelope refuses to fold it into the baseline.
    const overflow = e(EventType.TRANSPORT_OVERFLOW, { data: { dropped: 42 } });
    expect(computeSegments([net(200, true), overflow])[0]?.truncated).toBe(true);
  });

  it('returns no segments for an empty stream', () => {
    expect(computeSegments([])).toEqual([]);
  });
});
