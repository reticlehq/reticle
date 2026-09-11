/**
 * A `route` predicate used to be answerable only by a route CHANGE.
 *
 * `evalRoute` filtered the window to route-change events and, finding none, returned
 * `pass:false, "no route change observed"` — the current route was never consulted, though the
 * session tracks it and `reticle_snapshot({ mode: 'status' })` hands it back one call later. That is
 * how both reporters proved the verdict wrong:
 *
 *   "'Did the session survive a reload?' is a core verification and a reload by definition produces
 *    no route change."
 *   "reticle_assert { kind: 'route', pathname: '/login' } after a confirmed reticle_navigate to
 *    /login failed with 'no route change observed' even though snapshot.status.route was /login."
 *
 * Two of the commonest verifications there are, both a guaranteed false red — Reticle telling a user
 * their correct app is broken.
 *
 * The fallback must stay legible: "it changed to /login" and "it was already /login" are different
 * facts, and a caller asserting a redirect needs to tell them apart.
 */

import { describe, expect, it } from 'vitest';
import { evalRoute, RouteDecidedBy } from './predicate-route.js';
import { EventType, type ReticleEvent } from '@reticlehq/core';

const changed = (pathname: string): ReticleEvent[] => [
  { t: 1, type: EventType.ROUTE_CHANGE, sessionId: 's', data: { pathname } },
];

describe('a route predicate falls back to the current route', () => {
  it('passes on the current route when the window holds no route change', () => {
    const result = evalRoute(
      [],
      { kind: 'route', pathname: '/login' },
      'http://localhost:3000/login',
    );
    expect(result.pass).toBe(true);
  });

  it('says WHICH of the two decided it, so a redirect is not confused with a page already there', () => {
    expect(
      evalRoute([], { kind: 'route', pathname: '/login' }, 'http://localhost:3000/login'),
    ).toMatchObject({ evidence: { decidedBy: RouteDecidedBy.CURRENT } });
    expect(evalRoute(changed('/login'), { kind: 'route', pathname: '/login' })).toMatchObject({
      evidence: { decidedBy: RouteDecidedBy.CHANGE },
    });
  });

  it('matches `contains` against the whole current route — query and fragment included', () => {
    expect(
      evalRoute(
        [],
        { kind: 'route', contains: 'redirect=' },
        'http://localhost:3000/login?redirect=/app',
      ).pass,
    ).toBe(true);
  });

  it('fails against the current route by naming it, not by claiming nothing navigated', () => {
    const result = evalRoute(
      [],
      { kind: 'route', pathname: '/app' },
      'http://localhost:3000/login',
    );
    expect(result.pass).toBe(false);
    expect(result.observed).toContain('/login');
  });

  it('still reports "no route change observed" when there is no current route to read either', () => {
    expect(evalRoute([], { kind: 'route', pathname: '/login' }).failureReason).toBe(
      'no route change observed',
    );
  });
});
