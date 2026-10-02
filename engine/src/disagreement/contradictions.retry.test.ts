/**
 * A 401 that refreshed a token and retried is the app working, and it was read as two defects.
 *
 * From a field session, on an app whose `api-client.ts` documents the pattern: every call that meets
 * a 401 re-hydrates the session and retries once. Driving one extraction produced exactly that —
 * one 401 (51ms, 35 bytes), then one 200 (2278ms, 605 bytes), and exactly one extraction in state.
 *
 * Reticle reported it as `duplicate-request ×2` AND `ui-advanced-request-failed 401`: two separate
 * contradictions, both false, from one correct and extremely common mechanism. The reporter had to
 * spend calls disproving both, and wrote that "a heuristic that manufactures reds undercuts the
 * product more than a missed bug would" — which is right, because the whole claim is that only green
 * means green.
 *
 * The discriminator is structural, not a timing heuristic. A failure that a LATER success to the
 * same endpoint replaced is a failure the app recovered from: the write applied, the UI was entitled
 * to move, and nothing about the window contradicts a success claim. A real double submit is two
 * writes that both LANDED, and a real unrecovered failure has no success after it.
 */
import { describe, expect, it } from 'vitest';
import { ContradictionKind, EventType, type ReticleEvent } from '@reticlehq/core';
import { findContradictions } from './contradictions.js';

let seq = 0;
const ev = (type: EventType, data: Record<string, unknown> = {}): ReticleEvent => {
  seq += 1;
  return { t: seq, seq, type, sessionId: 's', data };
};
const call = (status: number, ok: boolean, url = '/api/extract', method = 'POST'): ReticleEvent =>
  ev(EventType.NET_REQUEST, { id: `n${String(seq)}`, method, url, status, ok });
const uiMoved = (): ReticleEvent => ev(EventType.STATE_CHANGE, { store: 'cad', path: 'bodies' });

const kinds = (events: ReticleEvent[]): string[] =>
  findContradictions(events, { actionSince: 0 }).map((c) => c.kind);

describe('a failure the app retried and recovered from', () => {
  /** The exact field shape: 401, then the same call again, then the UI advances. */
  const retried = (): ReticleEvent[] => [call(401, false), call(200, true), uiMoved()];

  it('is not the UI advancing over a failed request', () => {
    expect(kinds(retried())).not.toContain(ContradictionKind.UI_ADVANCED_REQUEST_FAILED);
  });

  it('is not a duplicate request — the write landed once', () => {
    expect(kinds(retried())).not.toContain(ContradictionKind.DUPLICATE_REQUEST);
  });

  it('is not a success signal contradicted by a failed write', () => {
    const withSignal = [
      call(401, false),
      call(200, true),
      ev(EventType.SIGNAL, { name: 'extract:done' }),
      uiMoved(),
    ];
    expect(kinds(withSignal)).not.toContain(ContradictionKind.SIGNAL_CONTRADICTED);
  });
});

describe('what recovery must NOT hide', () => {
  it('still reports a failure with no success after it', () => {
    // The ordinary unrecovered case. A success BEFORE the failure is not a retry of it.
    expect(kinds([call(200, true), call(500, false), uiMoved()])).toContain(
      ContradictionKind.UI_ADVANCED_REQUEST_FAILED,
    );
  });

  it('still reports a failure that a success to a DIFFERENT endpoint followed', () => {
    expect(
      kinds([call(500, false, '/api/save'), call(200, true, '/api/telemetry'), uiMoved()]),
    ).toContain(ContradictionKind.UI_ADVANCED_REQUEST_FAILED);
  });

  it('still reports a failure that a different METHOD succeeded after', () => {
    expect(
      kinds([call(500, false, '/api/x', 'POST'), call(200, true, '/api/x', 'GET'), uiMoved()]),
    ).toContain(ContradictionKind.UI_ADVANCED_REQUEST_FAILED);
  });

  it('still reports a real double submit — two writes that BOTH landed', () => {
    // This is the damaging case the rule exists for: the write applied twice.
    expect(kinds([call(200, true), call(200, true), uiMoved()])).toContain(
      ContradictionKind.DUPLICATE_REQUEST,
    );
  });

  it('does not call two failures a duplicate — nothing applied even once', () => {
    expect(kinds([call(500, false), call(500, false), uiMoved()])).not.toContain(
      ContradictionKind.DUPLICATE_REQUEST,
    );
  });
});
