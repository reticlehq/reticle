import { describe, it, expect } from 'vitest';
import { EventType, PredicateKind } from '@reticlehq/core';
import type { ReticleEvent } from '@reticlehq/core';
import { evalNet } from './predicate-eval.js';

/**
 * #2069, the path @pcbeingused333 isolated on the issue: the browser SDK's network observer
 * reports only the FIRST resource timing entry for a URL (the seen-set in
 * adapters/realm/browser/src/observers/network.ts). A media element load leaves no other record,
 * so when that first entry lands before the window opens, a repeat load inside the window is
 * never reported either and the window reads empty. An empty window there is not evidence the
 * file did not load: grading it a plain `no` sends the caller to fix a load that works. The miss
 * grades unknown instead — the same honesty rule as the media-load blind spot, one step earlier.
 *
 * The downgrade is deliberately narrow. It needs an actual media entry before the window whose
 * URL (and method, when the clause names one) matches the filter. A fetch or XHR record before
 * the window impeaches nothing: the patched transports report every call, so a repeat would
 * have been seen.
 */
function netEvent(t: number, data: Record<string, unknown>): ReticleEvent {
  return { type: EventType.NET_REQUEST, t, data } as ReticleEvent;
}

/** The record the SDK emits for a cross-origin <video> load: no readable status, initiator video. */
const MEDIA_ENTRY = {
  method: 'GET',
  url: 'https://cdn.example.com/watch/9f8e7d',
  initiator: 'video',
};

describe('a media load whose only record precedes the window', () => {
  it('grades a status check unknown, never a plain no', () => {
    const r = evalNet([netEvent(5, MEDIA_ENTRY)], {
      kind: PredicateKind.NET,
      urlContains: 'watch/9f8e7d',
      status: 206,
      since: 10,
    });
    expect(r.pass).toBe(false);
    expect(r.inconclusive).toBeDefined();
    expect(r.assertion).toBe('net.media-before-window');
  });

  it('grades a presence check unknown, never a plain no', () => {
    const r = evalNet([netEvent(5, MEDIA_ENTRY)], {
      kind: PredicateKind.NET,
      urlContains: 'watch/9f8e7d',
      since: 10,
    });
    expect(r.pass).toBe(false);
    expect(r.inconclusive).toBeDefined();
    expect(r.assertion).toBe('net.media-before-window');
  });

  it('grades an exact-count check unknown when the window reads empty', () => {
    const r = evalNet([netEvent(5, MEDIA_ENTRY)], {
      kind: PredicateKind.NET,
      urlContains: 'watch/9f8e7d',
      count: 1,
      since: 10,
    });
    expect(r.pass).toBe(false);
    expect(r.inconclusive).toBeDefined();
    expect(r.assertion).toBe('net.media-before-window');
  });

  it('covers an audio load the same way', () => {
    const r = evalNet(
      [
        netEvent(5, {
          method: 'GET',
          url: 'https://cdn.example.com/episode/42',
          initiator: 'audio',
        }),
      ],
      { kind: PredicateKind.NET, urlContains: 'episode/42', status: 206, since: 10 },
    );
    expect(r.pass).toBe(false);
    expect(r.inconclusive).toBeDefined();
    expect(r.assertion).toBe('net.media-before-window');
  });

  it('covers the record shape with no method stamped (older SDK)', () => {
    const r = evalNet(
      [netEvent(5, { url: 'https://cdn.example.com/watch/9f8e7d', initiator: 'video' })],
      { kind: PredicateKind.NET, urlContains: 'watch/9f8e7d', status: 206, since: 10 },
    );
    expect(r.pass).toBe(false);
    expect(r.inconclusive).toBeDefined();
    expect(r.assertion).toBe('net.media-before-window');
  });

  it('still grades a plain no when no earlier entry exists at all', () => {
    const r = evalNet([], {
      kind: PredicateKind.NET,
      urlContains: 'watch/9f8e7d',
      status: 206,
      since: 10,
    });
    expect(r.pass).toBe(false);
    expect(r.inconclusive).toBeUndefined();
    expect(r.assertion).toBe('net.present');
  });

  it('still grades a plain no when the earlier record is a fetch of the same URL', () => {
    // The patched transports report every call, so an earlier fetch record does not hide a
    // repeat: had the file been fetched again inside the window, the window would show it.
    const r = evalNet(
      [
        netEvent(5, {
          method: 'GET',
          url: 'https://cdn.example.com/watch/9f8e7d',
          initiator: 'fetch',
          status: 200,
          ok: true,
        }),
      ],
      { kind: PredicateKind.NET, urlContains: 'watch/9f8e7d', status: 206, since: 10 },
    );
    expect(r.pass).toBe(false);
    expect(r.inconclusive).toBeUndefined();
    expect(r.assertion).toBe('net.present');
  });

  it('still grades a plain no when the earlier media entry names a different URL', () => {
    const r = evalNet(
      [
        netEvent(5, {
          method: 'GET',
          url: 'https://cdn.example.com/watch/other',
          initiator: 'video',
        }),
      ],
      { kind: PredicateKind.NET, urlContains: 'watch/9f8e7d', status: 206, since: 10 },
    );
    expect(r.pass).toBe(false);
    expect(r.inconclusive).toBeUndefined();
    expect(r.assertion).toBe('net.present');
  });

  it('still grades a plain no when the filter names a method a media load cannot have', () => {
    const r = evalNet([netEvent(5, MEDIA_ENTRY)], {
      kind: PredicateKind.NET,
      urlContains: 'watch/9f8e7d',
      method: 'POST',
      since: 10,
    });
    expect(r.pass).toBe(false);
    expect(r.inconclusive).toBeUndefined();
    expect(r.assertion).toBe('net.present');
  });

  it('does not impeach a real in-window match', () => {
    const r = evalNet(
      [netEvent(5, MEDIA_ENTRY), netEvent(15, { ...MEDIA_ENTRY, status: 206, ok: true })],
      { kind: PredicateKind.NET, urlContains: 'watch/9f8e7d', status: 206, since: 10 },
    );
    expect(r.pass).toBe(true);
  });

  it('leaves the in-window unreadable-status downgrade as it was', () => {
    const r = evalNet([netEvent(15, MEDIA_ENTRY)], {
      kind: PredicateKind.NET,
      urlContains: 'watch/9f8e7d',
      status: 206,
      since: 10,
    });
    expect(r.pass).toBe(false);
    expect(r.inconclusive).toBeDefined();
    expect(r.assertion).toBe('net.unobservable-status');
  });
});
