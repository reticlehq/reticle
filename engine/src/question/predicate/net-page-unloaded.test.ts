/**
 * #1944: a request whose document unloaded before its answer arrived has an unknown outcome.
 *
 * The daemon carries the old document's network records into the session of the new document.
 * A request that had no answer is carried as a `NET_PENDING` marked `pageUnloaded`. Its answer goes
 * to a document that no longer exists, so no `NET_REQUEST` can ever close it.
 *
 * - A `net` check that only this record matches is `unknown`, never `no`: the page sent the
 *   request, and nobody saw what the server did with it.
 * - It is not a request in flight. If it counted, settle would never pass on the new page, and
 *   every verdict there would carry "a request never settled".
 */

import { describe, expect, it } from 'vitest';
import {
  ContradictionKind,
  DepartedNetField,
  EventType,
  NetInitiator,
  PredicateKind,
  type ReticleEvent,
} from '@reticlehq/core';
import { findContradictions } from '../../disagreement/contradictions.js';
import { evalNet, evalSettled } from './predicate-eval.js';
import type { Predicate } from './predicate-schema.js';

type NetPredicate = Extract<Predicate, { kind: 'net' }>;

const SIGN_OUT = '/api/sign-out';

function event(type: EventType, t: number, data: Record<string, unknown>): ReticleEvent {
  return { t, type, sessionId: 's', data };
}

const unloaded = (t: number): ReticleEvent =>
  event(EventType.NET_PENDING, t, {
    id: 'n2',
    method: 'POST',
    url: SIGN_OUT,
    initiator: NetInitiator.FETCH,
    [DepartedNetField.FROM_DEPARTED_DOCUMENT]: true,
    [DepartedNetField.PAGE_UNLOADED]: true,
  });

const answeredBeforeUnload = (t: number): ReticleEvent =>
  event(EventType.NET_REQUEST, t, {
    id: 'n2',
    method: 'POST',
    url: SIGN_OUT,
    status: 200,
    ok: true,
    durationMs: 3,
    initiator: NetInitiator.FETCH,
    [DepartedNetField.FROM_DEPARTED_DOCUMENT]: true,
  });

const SIGN_OUT_POST: NetPredicate = { kind: 'net', method: 'POST', urlContains: SIGN_OUT };

describe('a net check on a request whose page unloaded before the answer (#1944)', () => {
  it('is unknown, and says the page unloaded, instead of "no call matched"', () => {
    const r = evalNet([unloaded(0)], SIGN_OUT_POST);
    expect(r.pass).toBe(false);
    expect(r.inconclusive).toContain('unloaded');
    expect(r.failureReason).not.toContain('no network call matched');
  });

  it('is unknown for a status clause too', () => {
    const r = evalNet([unloaded(0)], { ...SIGN_OUT_POST, status: 200 });
    expect(r.inconclusive).toContain('unloaded');
  });

  it('is unknown for an exact count, since the unloaded request is not counted', () => {
    const r = evalNet([unloaded(0)], { ...SIGN_OUT_POST, count: 1 });
    expect(r.pass).toBe(false);
    expect(r.inconclusive).toContain('unloaded');
  });

  it('passes on a request the old document saw answered before it unloaded', () => {
    expect(evalNet([answeredBeforeUnload(0)], SIGN_OUT_POST).pass).toBe(true);
  });

  it('stays a plain miss for another URL', () => {
    const r = evalNet([unloaded(0)], { kind: 'net', urlContains: '/api/other' });
    expect(r.inconclusive).toBeUndefined();
  });

  it('stays a plain miss when the unloaded request is before the window', () => {
    const r = evalNet([unloaded(0)], { ...SIGN_OUT_POST, since: 10 });
    expect(r.inconclusive).toBeUndefined();
  });
});

describe('a request whose page unloaded is not in flight (#1944)', () => {
  it('does not hold settle open on the new page', () => {
    const r = evalSettled([unloaded(0)], { kind: PredicateKind.SETTLED, quietMs: 100 }, 1_000);
    expect(r.pass).toBe(true);
  });

  // Found by driving the fix: the new page records no DOM change for its first render, so a POST
  // from the old document read as "a write succeeded and nothing on the client moved".
  it('a write the old document made is not a response the client ignored', () => {
    const found = findContradictions([answeredBeforeUnload(0)], {
      actionSince: 0,
      action: 'click',
    });
    expect(found.map((c) => c.kind)).not.toContain(ContradictionKind.RESPONSE_IGNORED);
  });

  it('is not a request that never settled when the UI moved', () => {
    const moved = event(EventType.ROUTE_CHANGE, 1, {
      from: 'http://localhost/account',
      to: 'http://localhost/sign-in',
      pathname: '/sign-in',
      search: '',
      hash: '',
    });
    const found = findContradictions([unloaded(0), moved], { actionSince: 0 });
    expect(found.map((c) => c.kind)).not.toContain(ContradictionKind.REQUEST_NEVER_SETTLED);
  });
});
