/**
 * #1660: a `net` miss over a request sent through a `fetch` saved before connect() is `unknown`.
 *
 * A client library can store `window.fetch` when its module loads. Reticle patches `fetch` later,
 * so a call through the stored function makes no `net.request`. The SDK reports the browser's own
 * record of it as `net.unpatched`. The miss answered `no`, "no call matched", while the server got
 * the request.
 */

import { describe, expect, it } from 'vitest';
import { EventType, type ReticleEvent } from '@reticlehq/core';
import { evalNet } from './predicate-eval.js';
import type { Predicate } from './predicate-schema.js';

type NetPredicate = Extract<Predicate, { kind: 'net' }>;

function event(type: EventType, t: number, data: Record<string, unknown>): ReticleEvent {
  return { t, seq: t, type, sessionId: 's', data };
}

const unpatched = (t: number, url: string): ReticleEvent =>
  event(EventType.NET_UNPATCHED, t, { url, initiator: 'fetch' });

const PING: NetPredicate = { kind: 'net', urlContains: '/api/ping', since: 10 };

describe('a net miss over a fetch that Reticle did not patch', () => {
  it('is unknown, and says to connect Reticle earlier, when a marker matches the URL', () => {
    const r = evalNet([unpatched(20, 'http://app.test/api/ping')], PING);
    expect(r.pass).toBe(false);
    expect(r.inconclusive).toContain('saved before Reticle connected');
    expect(r.inconclusive).toContain('build plugin');
  });

  it('is unknown for a method clause too, which the marker cannot judge', () => {
    const r = evalNet([unpatched(20, 'http://app.test/api/ping')], { ...PING, method: 'POST' });
    expect(r.inconclusive).toContain('saved before Reticle connected');
  });

  it('is unknown for an exact count, since the marked call is not counted', () => {
    const r = evalNet([unpatched(20, 'http://app.test/api/ping')], { ...PING, count: 0 });
    expect(r.pass).toBe(false);
    expect(r.inconclusive).toContain('saved before Reticle connected');
  });

  it('stays a plain miss when the marker is for another URL or before the window', () => {
    const other = evalNet([unpatched(20, 'http://app.test/api/other')], PING);
    expect(other.inconclusive).toBeUndefined();
    const before = evalNet([unpatched(5, 'http://app.test/api/ping')], PING);
    expect(before.inconclusive).toBeUndefined();
  });

  it('passes on the patched record, whatever marker is also there', () => {
    const r = evalNet(
      [
        event(EventType.NET_REQUEST, 20, {
          id: 'n1',
          method: 'POST',
          url: 'http://app.test/api/ping',
          status: 200,
          ok: true,
          durationMs: 3,
          initiator: 'fetch',
        }),
        unpatched(21, 'http://app.test/api/ping'),
      ],
      PING,
    );
    expect(r.pass).toBe(true);
  });
});
