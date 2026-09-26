/**
 * A net clause naming the document URL, missed across a full page load, is a blind spot.
 *
 * Reported on a Django MPA: `act_and_wait` returned `verified: "unknown"` with the route and
 * heading clauses PASSING and `net GET /openworker/` missing. The request demonstrably happened --
 * the page the session is standing on is its response -- but the SDK tore down with the old
 * document and reconnected on the new one, so it is not in the window (#898).
 *
 * The tests below pin both halves. The excuse has to fire on the reported shape, and it must NOT
 * fire on a client-side navigation to the same path, where the request was observable and its
 * absence is the finding the oracle exists to make.
 */

import { describe, expect, it } from 'vitest';
import { EventType } from '@reticlehq/core';
import type { ReticleEvent } from '@reticlehq/core';
import {
  documentNavigationReason,
  missedTheDocumentNavigation,
} from './net-document-navigation.js';
import { evalNet } from './predicate-eval.js';
import { PredicateKind } from './predicate.js';

const SESSION_ID = 's1';

const routeChange = (to: string): ReticleEvent => ({
  type: EventType.ROUTE_CHANGE,
  t: 10,
  sessionId: SESSION_ID,
  data: { to, pathname: to },
});

const netCall = (url: string): ReticleEvent => ({
  type: EventType.NET_REQUEST,
  t: 20,
  sessionId: SESSION_ID,
  data: { url, method: 'GET', status: 200 },
});

const HERE = 'http://127.0.0.1:8000/openworker/';

describe('a net miss that is really the document navigation', () => {
  it('is recognised on the reported shape', () => {
    expect(missedTheDocumentNavigation([], { urlContains: '/openworker/' }, HERE)).toBe(true);
  });

  it("is recognised alongside the new document's own subresources", () => {
    // After the reconnect the window is not empty: the new page's assets are in it. That must not
    // read as "the observer was alive, so the miss is real".
    const events = [netCall('http://127.0.0.1:8000/static/app.css')];
    expect(missedTheDocumentNavigation(events, { urlContains: '/openworker/' }, HERE)).toBe(true);
  });

  it('covers an explicit GET, which is what a link navigation is', () => {
    expect(
      missedTheDocumentNavigation([], { urlContains: '/openworker/', method: 'get' }, HERE),
    ).toBe(true);
  });
});

describe('what the excuse must not swallow', () => {
  it('does not fire when the window carries a route change', () => {
    // A client-side navigation to the same path: the SDK never went away, so a request it did not
    // record is a request that did not happen. That is the finding.
    const events = [routeChange('/openworker/')];
    expect(missedTheDocumentNavigation(events, { urlContains: '/openworker/' }, HERE)).toBe(false);
  });

  it('does not fire for a URL that is not where the session ended up', () => {
    expect(missedTheDocumentNavigation([], { urlContains: '/api/v1/save' }, HERE)).toBe(false);
  });

  it('does not fire for a POST, which the OLD document observed before it went away', () => {
    expect(
      missedTheDocumentNavigation([], { urlContains: '/openworker/', method: 'POST' }, HERE),
    ).toBe(false);
  });

  it('does not fire for a clause that names no URL at all', () => {
    expect(missedTheDocumentNavigation([], { method: 'GET' }, HERE)).toBe(false);
    expect(missedTheDocumentNavigation([], { urlContains: '' }, HERE)).toBe(false);
  });

  it('does not fire without a session URL, because nothing then says where the page is', () => {
    expect(missedTheDocumentNavigation([], { urlContains: '/openworker/' }, undefined)).toBe(false);
  });

  it('matches on path and search, not on the origin', () => {
    // `urlContains: "127.0.0.1"` names the host, which every request on the page shares; excusing
    // that would excuse every miss on a localhost app.
    expect(missedTheDocumentNavigation([], { urlContains: '127.0.0.1' }, HERE)).toBe(false);
  });

  it('survives a session URL that will not parse', () => {
    expect(missedTheDocumentNavigation([], { urlContains: 'openworker' }, 'not a url')).toBe(false);
  });
});

describe('the sentence', () => {
  it('names the cause and what to assert on instead', () => {
    const reason = documentNavigationReason({ urlContains: '/openworker/' }, HERE);

    expect(reason).toContain('/openworker/');
    expect(reason).toContain('FULL DOCUMENT');
    expect(reason).toContain('blind spot');
    expect(reason).toContain('route');
  });

  it('does not claim the request never happened', () => {
    const reason = documentNavigationReason({ urlContains: '/openworker/' }, HERE);

    expect(reason).not.toMatch(/never fired|did not happen\b/);
    expect(reason).toContain('IS the response');
  });
});

describe('through evalNet, which is where the verdict is written', () => {
  const clause = { kind: PredicateKind.NET, method: 'GET', urlContains: '/openworker/' } as const;

  it('grades the reported case inconclusive rather than failed', () => {
    const result = evalNet([], clause, HERE);

    expect(result.pass).toBe(false);
    expect(result.inconclusive).toBeDefined();
    expect(result.assertion).toBe('net.document-navigation');
  });

  it('still grades a genuinely absent request as a plain miss', () => {
    // Same clause, but the session never left /cloud/: the request is missing and that is the answer.
    const result = evalNet([], clause, 'http://127.0.0.1:8000/cloud/');

    expect(result.inconclusive).toBeUndefined();
    expect(result.assertion).toBe('net.present');
  });

  it('still passes when the call IS in the window', () => {
    const result = evalNet([netCall('http://127.0.0.1:8000/openworker/')], clause, HERE);

    expect(result.pass).toBe(true);
  });

  it('answers as before when the caller has no session URL', () => {
    expect(evalNet([], clause).assertion).toBe('net.present');
  });
});
