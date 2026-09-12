/**
 * A server that never answers must not be graded as the app failing to navigate.
 *
 * `routeChanges: 0, network: 0` reads identically whether the APP prevented the navigation or the
 * SERVER never answered the request the app made. Reticle saw the pending navigation and had the
 * evidence to tell them apart, but surfaced only the app-side reading — and attached a `source:`
 * file:line, which points the investigation at innocent code.
 *
 * Reported against a Next.js dev server wedged mid-`[Fast Refresh] rebuilding`: it still held the
 * port and accepted connections but never sent a body. The verdict named
 * `components/.../header.tsx:53` and the reporter nearly filed "the header Sign Up link is broken".
 * Establishing the truth required leaving Reticle entirely — `curl` returned HTTP 000 after 25s.
 *
 * Not a dev-server edge case: a crashed server, a proxy that swallows requests and an OOMed backend
 * all present in exactly this shape.
 */

import { describe, expect, it } from 'vitest';
import { EventType } from '@reticlehq/core';
import type { ReticleEvent } from '@reticlehq/core';
import { evalRoute } from './predicate/predicate-route.js';

const pending = (id: string, url: string, t: number): ReticleEvent =>
  ({ type: EventType.NET_PENDING, t, data: { id, url, method: 'GET' } }) as unknown as ReticleEvent;

const completed = (id: string, url: string, t: number): ReticleEvent =>
  ({
    type: EventType.NET_REQUEST,
    t,
    data: { id, url, method: 'GET', status: 200 },
  }) as unknown as ReticleEvent;

describe('a route miss over an unanswered request is not the app’s failure', () => {
  it('is inconclusive, not a product failure, when a request never settled', () => {
    const result = evalRoute([pending('r1', '/dashboard?_rsc=abc', 12)], {
      kind: 'route',
      pathname: '/dashboard',
    });
    expect(result.pass).toBe(false);
    expect(
      result.inconclusive,
      'nobody could have made this true — the server never answered',
    ).toBeTypeOf('string');
    expect(result.failureReason).toMatch(/pending|never (completed|answered)|has not responded/i);
  });

  it('names the request, so the caller can check it outside the browser', () => {
    const result = evalRoute([pending('r1', '/dashboard?_rsc=abc', 12)], {
      kind: 'route',
      pathname: '/dashboard',
    });
    expect(String(result.inconclusive)).toContain('/dashboard');
  });

  it('stays a plain product failure when every request settled', () => {
    // The app really did not navigate, and nothing was in flight to explain it. This is the finding
    // the oracle exists to make and must not be softened.
    const result = evalRoute([pending('r1', '/api/x', 12), completed('r1', '/api/x', 30)], {
      kind: 'route',
      pathname: '/dashboard',
    });
    expect(result.pass).toBe(false);
    expect(result.inconclusive).toBeUndefined();
  });

  it('ignores a request that was already in flight before the window', () => {
    // A background poll that predates the action says nothing about this navigation. Counting it
    // would make every route miss on a polling app inconclusive — the failure this oracle exists
    // to report, softened into silence.
    const result = evalRoute(
      [pending('bg', '/api/poll', 5)],
      { kind: 'route', pathname: '/dashboard' },
      undefined,
      20,
    );
    expect(result.inconclusive).toBeUndefined();
  });
});
