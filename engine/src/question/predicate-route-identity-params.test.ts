/**
 * Reticle appends its OWN identity params to a leased tab's URL — `__reticle_session` and
 * `__reticle_project` — so the app's SDK adopts the lease without any app code changing. They are
 * bookkeeping, and reporting them back as evidence is Reticle paying tokens to tell itself
 * something it wrote.
 *
 * Measured on a real drive against the bench app: a passing route verdict returned `from`, `to` and
 * `search`, each carrying the same `__reticle_session=lease-8312a203-…` UUID. That is 58 of the
 * evidence block's 96 tokens — 60% of it — for one value stated three times, none of which is about
 * the app. The app's own query params are untouched: they ARE evidence, and a redirect that drops
 * one is exactly the kind of bug a route assertion exists to catch.
 */

import { describe, expect, it } from 'vitest';
import { evalRoute } from './predicate/predicate-route.js';
import { EventType, PredicateKind, type ReticleEvent } from '@reticlehq/core';

const LEASE = '__reticle_session=lease-8312a203-c1e8-424f-9e71-487bf3ae38ec';
const routeChange = (): ReticleEvent[] => [
  {
    t: 1,
    type: EventType.ROUTE_CHANGE,
    sessionId: 's',
    data: {
      from: `http://localhost:4312/?${LEASE}`,
      to: `http://localhost:4312/compose?tab=draft&${LEASE}`,
      pathname: '/compose',
      search: `?tab=draft&${LEASE}`,
      hash: '',
    },
  },
];

describe('route evidence does not echo Reticle’s own identity params', () => {
  const evaluate = () =>
    evalRoute(routeChange(), { kind: PredicateKind.ROUTE, contains: 'compose' });

  it('strips them from every URL it reports', () => {
    const json = JSON.stringify(evaluate().evidence ?? {});
    expect(json).not.toContain('__reticle_session');
    expect(json).not.toContain('__reticle_project');
  });

  it('keeps the app’s own query params, which ARE evidence', () => {
    const json = JSON.stringify(evaluate().evidence ?? {});
    expect(json).toContain('tab=draft');
  });

  it('still answers the predicate', () => {
    expect(evaluate().pass).toBe(true);
  });
});
