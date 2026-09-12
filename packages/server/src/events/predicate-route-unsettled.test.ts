/**
 * A route predicate that passed on the URL alone must say so.
 *
 * `route` goes green the moment the URL commits. On any async-loading page that is a verdict taken
 * over a page which has not rendered its content — and the observation an agent naturally takes
 * next, a snapshot, is exactly the one that is untrustworthy in that window.
 *
 * Reported with the whole sequence: an `allOf [route, console absent]` returned `verified: "yes"`,
 * a snapshot of `main` came back with 9 nodes that read as an empty shell, and re-snapshotting
 * moments later showed 22 nodes with the real content. The reporter was one step away from filing
 * "this route renders nothing" against code that was fine.
 *
 * The grade is NOT changed. Nobody's green suite flips, and requiring a settle would make every
 * route assertion wait — the reporter's own acceptance allows either "does not go green" or "its
 * evidence says the view had not settled", and the second costs nothing that was already working.
 *
 * The signal needs no clock: if the route change is the LAST thing in the window, nothing has been
 * observed since the URL moved. That is exactly the trap, and it is the cheapest true statement
 * available.
 */

import { describe, expect, it } from 'vitest';
import { EventType } from '@reticlehq/core';
import type { ReticleEvent } from '@reticlehq/core';
import { evalRoute } from './predicate-route.js';

const routeEvent = (path: string, t: number): ReticleEvent =>
  ({
    type: EventType.ROUTE_CHANGE,
    t,
    data: { pathname: path, hash: '', url: `http://app.test${path}` },
  }) as unknown as ReticleEvent;

const domEvent = (t: number): ReticleEvent =>
  ({ type: EventType.DOM_ADDED, t, data: {} }) as unknown as ReticleEvent;

const evidenceOf = (result: { evidence?: unknown }): Record<string, unknown> =>
  (result.evidence ?? {}) as Record<string, unknown>;

describe('a route pass says whether anything rendered after the URL moved', () => {
  it('flags a pass where the route change is the last thing in the window', () => {
    const result = evalRoute([routeEvent('/list', 10)], { kind: 'route', pathname: '/list' });
    expect(result.pass, 'the URL did commit — this is not a failure').toBe(true);
    expect(
      evidenceOf(result)['viewSettled'],
      'nothing was observed after the URL moved, so nothing is known about the render',
    ).toBe(false);
  });

  it('does not flag a pass where the page went on working after the route', () => {
    const result = evalRoute([routeEvent('/list', 10), domEvent(40)], {
      kind: 'route',
      pathname: '/list',
    });
    expect(result.pass).toBe(true);
    expect(evidenceOf(result)['viewSettled']).toBe(true);
  });

  it('ignores activity that PRECEDED the route change', () => {
    // A mutation before the navigation says nothing about what the new route rendered.
    const result = evalRoute([domEvent(5), routeEvent('/list', 10)], {
      kind: 'route',
      pathname: '/list',
    });
    expect(evidenceOf(result)['viewSettled']).toBe(false);
  });

  it('says nothing about settling when the pass came from the CURRENT url', () => {
    // Decided by "the app is already there", not by a navigation, so there is no commit moment to
    // be too close to — and claiming otherwise would put a caveat on a reading it does not describe.
    const result = evalRoute([], { kind: 'route', pathname: '/list' }, 'http://app.test/list');
    expect(result.pass).toBe(true);
    expect(evidenceOf(result)['viewSettled']).toBeUndefined();
  });

  it('leaves a FAILING route untouched', () => {
    const result = evalRoute([routeEvent('/other', 10)], { kind: 'route', pathname: '/list' });
    expect(result.pass).toBe(false);
    expect(evidenceOf(result)['viewSettled']).toBeUndefined();
  });
});
