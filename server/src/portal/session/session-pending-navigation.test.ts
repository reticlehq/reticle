/**
 * A request that has been in flight for a long time is a session-health fact.
 *
 * Both reporters on the hung-server issue said the same thing: a pending-request age in
 * `reticle_sessions` health would have been enough on its own. One sat on an RSC fetch stuck at
 * `status: "pending"` for 170+ seconds across many `act_and_wait`/`observe` calls, with
 * `routeChanges: 0` every time; the other had a Next dev server that accepted connections and never
 * sent a body. In both, Reticle held the evidence and never surfaced it, and the truth was
 * eventually established with `curl`.
 *
 * The verdict-level fix (route.server-pending) answers the caller who ASKED about a route. This
 * answers the caller who has not asked anything yet — it rides on the health envelope, so it reaches
 * an agent listing sessions before it drives at all.
 *
 * Omitted when there is nothing to say, like every other field on this envelope: a healthy session
 * costs zero extra bytes.
 */

import { describe, expect, it } from 'vitest';
import { EventType } from '@reticlehq/core';
import type { ReticleEvent } from '@reticlehq/core';
import { pendingNavigationMs, PENDING_NAVIGATION_NOTICE_MS } from './session-health.js';

const pending = (id: string, t: number): ReticleEvent =>
  ({
    type: EventType.NET_PENDING,
    t,
    data: { id, url: '/dashboard?_rsc=abc', method: 'GET' },
  }) as unknown as ReticleEvent;

const settled = (id: string, t: number): ReticleEvent =>
  ({ type: EventType.NET_REQUEST, t, data: { id, status: 200 } }) as unknown as ReticleEvent;

describe('a long-pending request is reported on session health', () => {
  it('reports the age of the OLDEST unsettled request', () => {
    const now = 20_000;
    const age = pendingNavigationMs([pending('a', 500), pending('b', 9_000)], now);
    expect(age, 'the oldest is the one that says the server is not answering').toBe(19_500);
  });

  it('says nothing when every request settled', () => {
    expect(pendingNavigationMs([pending('a', 500), settled('a', 800)], 20_000)).toBeUndefined();
  });

  /**
   * A deliberately slow endpoint is not a wedge, and this repo has one: the e2e battery runs its API
   * with `REFLECT_MS=6000`. At the 5s this shipped with, a healthy app with one slow route was
   * permanently non-nominal and carried a scary number on every result.
   */
  it('does not fire on an app with a legitimately slow endpoint', () => {
    expect(pendingNavigationMs([pending('slow', 0)], 6_000)).toBeUndefined();
  });

  it('still catches both cases it was built for', () => {
    // The two the reporters measured: 10.4s and 170s+. The first clears the bar by 400ms, which is
    // thin on purpose — the alternative is a bar low enough to fire on every slow endpoint, and a
    // field that fires on healthy sessions is a field agents learn to skip.
    expect(pendingNavigationMs([pending('a', 0)], 10_400)).toBe(10_400);
    expect(pendingNavigationMs([pending('a', 0)], 172_000)).toBe(172_000);
  });

  it('says nothing about a request that is merely in flight right now', () => {
    // A drive always has requests in the air. Reporting those would put a scary number on every
    // healthy session and train agents to ignore the field.
    const now = 1_000;
    expect(pendingNavigationMs([pending('a', 900)], now)).toBeUndefined();
    expect(PENDING_NAVIGATION_NOTICE_MS).toBeGreaterThan(0);
  });

  it('reports it the moment it crosses the threshold, not a tick later', () => {
    const start = 100;
    const now = start + PENDING_NAVIGATION_NOTICE_MS;
    expect(pendingNavigationMs([pending('a', start)], now)).toBe(PENDING_NAVIGATION_NOTICE_MS);
  });

  it('ignores a settled request that is older than an unsettled one', () => {
    // Order in the buffer is not the question; matching ids is.
    const age = pendingNavigationMs(
      [pending('old', 100), settled('old', 200), pending('stuck', 1_000)],
      30_000,
    );
    expect(age).toBe(29_000);
  });
});
