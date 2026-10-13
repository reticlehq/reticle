/**
 * A working revocation was graded `no / signal-contradicted` "even though the assertion passed".
 *
 * From a persona drive: a member removed from a workspace had his open tab sent to /login, which
 * showed "You were removed from …". The refresh that told the app so answered the intended
 * `401 removed_from_workspace`, the new page hydrated, and the React adapter fired its
 * `reticle:hydration-complete`. The signal rule read that as the app claiming success over a failed
 * write. It is Reticle's own announcement that a page became interactive, not anything the app said
 * about a change it made, so it is no claim for a failed write to contradict.
 */
import { describe, expect, it } from 'vitest';
import {
  ContradictionKind,
  EventType,
  RETICLE_HYDRATION_SIGNAL,
  type ReticleEvent,
} from '@reticlehq/core';
import { findContradictions } from './contradictions.js';

let seq = 0;
const ev = (type: EventType, data: Record<string, unknown> = {}): ReticleEvent => {
  seq += 1;
  return { t: seq, seq, type, sessionId: 's', data };
};
const refused = (): ReticleEvent =>
  ev(EventType.NET_REQUEST, {
    id: 'n1',
    method: 'POST',
    url: '/v1/auth/refresh',
    status: 401,
    ok: false,
  });

/** A passive assert: nothing attributed the window to an action. */
const kinds = (events: ReticleEvent[]): string[] =>
  findContradictions(events, {}).map((c) => c.kind);

describe('a page that hydrated beside a refused write', () => {
  it('is not the app claiming success: a revocation the page handled is no contradiction', () => {
    const revoked = [
      refused(),
      ev(EventType.ROUTE_CHANGE, { from: '/runs', to: '/login' }),
      ev(EventType.SIGNAL, { name: RETICLE_HYDRATION_SIGNAL }),
    ];
    expect(kinds(revoked)).not.toContain(ContradictionKind.SIGNAL_CONTRADICTED);
  });

  it('still contradicts a success the app itself claimed over the same failed write', () => {
    const claimed = [
      refused(),
      ev(EventType.SIGNAL, { name: RETICLE_HYDRATION_SIGNAL }),
      ev(EventType.SIGNAL, { name: 'session:renewed' }),
    ];
    const found = findContradictions(claimed, {});
    const contradicted = found.find((c) => ContradictionKind.SIGNAL_CONTRADICTED === c.kind);
    expect(contradicted?.claim).toBe('the app fired "session:renewed"');
  });

  it('still catches a UI that moved forward while its own write failed', () => {
    const advanced = [
      ev(EventType.NET_REQUEST, {
        id: 'n2',
        method: 'POST',
        url: '/api/save',
        status: 500,
        ok: false,
      }),
      ev(EventType.SIGNAL, { name: RETICLE_HYDRATION_SIGNAL }),
      ev(EventType.STATE_CHANGE, { store: 'doc', path: 'saved', value: true }),
    ];
    expect(findContradictions(advanced, { actionSince: 0 }).map((c) => c.kind)).toContain(
      ContradictionKind.UI_ADVANCED_REQUEST_FAILED,
    );
  });
});
