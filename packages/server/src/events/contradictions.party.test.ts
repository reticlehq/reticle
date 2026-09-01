/**
 * Third-party traffic and a passive window must not decide a first-party verdict.
 *
 * An app with analytics installed struggled to produce a clean `verified` because a blocked
 * beacon (`status: 0, ok: false`) sat in the same window as a passing assertion and was read as a
 * failed request. A passive assert with no action then swept the whole ring buffer, so anything
 * that had ever happened in the session could contradict.
 */

import { describe, expect, it } from 'vitest';
import { ContradictionKind, EventType, type ReticleEvent } from '@reticlehq/core';
import { findContradictions } from './contradictions.js';

let seq = 0;
function ev(type: EventType, data: Record<string, unknown> = {}): ReticleEvent {
  seq += 1;
  return { t: seq, seq, type, sessionId: 's', data };
}

const pageUrl = 'https://www.shop.com/dashboard';
const domChanged = (): ReticleEvent => ev(EventType.DOM_REMOVED, { path: 'li' });
const beacon = (): ReticleEvent =>
  ev(EventType.NET_REQUEST, {
    id: `b${String(seq)}`,
    method: 'POST',
    url: 'https://www.google-analytics.com/g/collect',
    status: 0,
    ok: false,
    initiator: 'beacon',
  });
const firstPartyFail = (): ReticleEvent =>
  ev(EventType.NET_REQUEST, {
    id: `n${String(seq)}`,
    method: 'POST',
    url: 'https://api.shop.com/orders',
    status: 500,
    ok: false,
  });
const blockedFirstParty = (): ReticleEvent =>
  ev(EventType.NET_REQUEST, {
    id: `n${String(seq)}`,
    method: 'GET',
    url: '/api/me',
    status: 0,
    ok: false,
  });

const kinds = (events: ReticleEvent[], opts: Parameters<typeof findContradictions>[1] = {}) =>
  findContradictions(events, opts).map((c) => c.kind);

describe('third-party failures do not decide verified', () => {
  it('does not let a blocked analytics beacon overturn a first-party window', () => {
    expect(kinds([domChanged(), beacon()], { actionSince: 0, pageUrl })).not.toContain(
      ContradictionKind.UI_ADVANCED_REQUEST_FAILED,
    );
  });

  it('still catches a first-party request that actually failed', () => {
    expect(kinds([domChanged(), firstPartyFail()], { actionSince: 0, pageUrl })).toContain(
      ContradictionKind.UI_ADVANCED_REQUEST_FAILED,
    );
  });

  it('does not call status 0 a failed request, even on the page origin', () => {
    expect(kinds([domChanged(), blockedFirstParty()], { actionSince: 0, pageUrl })).not.toContain(
      ContradictionKind.UI_ADVANCED_REQUEST_FAILED,
    );
  });
});

describe('a passive assert has no contradiction sweep', () => {
  it('stays silent when no action attributed the window', () => {
    expect(kinds([domChanged(), firstPartyFail(), beacon()], { pageUrl })).toEqual([]);
  });

  it('sweeps once the window is attributed to an action', () => {
    expect(kinds([domChanged(), firstPartyFail()], { actionSince: 0, pageUrl })).toContain(
      ContradictionKind.UI_ADVANCED_REQUEST_FAILED,
    );
  });
});
