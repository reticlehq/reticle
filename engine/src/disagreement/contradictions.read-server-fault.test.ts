/**
 * A read of the app's own that failed with a server error, inside the action window.
 *
 * Field report: a saved flow replayed with status ok and verdict pass. The same window held two
 * failed same-origin GETs, a 500 and a 502. The flow asserted the route, visible controls, date
 * labels and settled, and all of them held: the page kept stale or placeholder content. No rule
 * reported the faults, because the write rules skip a GET and the 5xx rule needs the app to blame
 * the user. The app had a real serialization bug.
 *
 * `findContradictions` is the one function that `act_and_wait`, `reticle_assert` and flow replay
 * (through `stepEffect`) all read, so the rule lives there and every path gets it.
 */
import { describe, expect, it } from 'vitest';
import {
  ContradictionKind,
  EventType,
  Verified,
  VerifiedReason,
  isAbsenceDerived,
  type ReticleEvent,
} from '@reticlehq/core';
import { findContradictions } from './contradictions.js';
import { decideVerified } from '@/evidence/verified.js';
import { HonestyGrade } from '@/evidence/honesty.js';
import { stepEffect } from '@/evidence/step-effect.js';

const APP = 'http://localhost:5173/reader';
const ACTION_AT = 10;

let seq = 0;
function ev(type: EventType, data: Record<string, unknown>, t?: number): ReticleEvent {
  seq += 1;
  return { t: t ?? ACTION_AT + seq, seq, type, sessionId: 's', data };
}
const get = (url: string, status: number, t?: number): ReticleEvent =>
  ev(EventType.NET_REQUEST, { id: `n${String(seq)}`, method: 'GET', url, status }, t);
/** The DOM that the passing predicate read: a label rendered whether or not the data came. */
const label = (): ReticleEvent => ev(EventType.DOM_TEXT, { text: 'Mon 3 Nov', old: '' });

const found = (events: ReticleEvent[]): string[] =>
  findContradictions(events, { actionSince: ACTION_AT, appOrigin: APP }).map((c) => c.kind);

/** A passing assertion at a real grade over a clean capture: what `yes` needs. */
function verdictOf(events: ReticleEvent[]) {
  return decideVerified({
    pass: true,
    settled: true,
    contradictions: findContradictions(events, { actionSince: ACTION_AT, appOrigin: APP }),
    honesty: {
      grade: HonestyGrade.PRESENCE,
      attribution: 'window',
      coverage: { pct: 100, partial: false },
      integrity: { clean: true, issues: [] },
    },
  });
}

/** The field window: two same-origin reads failed with 5xx, and the DOM predicate held. */
const fieldWindow = (): ReticleEvent[] => [
  label(),
  get('http://localhost:5173/api/articles?date=2026-11-03', 500),
  get('/api/feeds', 502),
];

describe('a same-origin read that failed with a 5xx in the action window', () => {
  it('is reported, naming each request and its status', () => {
    const all = findContradictions(fieldWindow(), { actionSince: ACTION_AT, appOrigin: APP });
    const fault = all.find((c) => c.kind === ContradictionKind.READ_SERVER_FAULT);
    expect(fault?.detail).toContain('GET http://localhost:5173/api/articles?date=2026-11-03 → 500');
    expect(fault?.detail).toContain('GET /api/feeds → 502');
  });

  it('downgrades a passing assertion to unknown and says why', () => {
    const out = verdictOf(fieldWindow());
    expect(out.verified).toBe(Verified.UNKNOWN);
    expect(out.verifiedReason).toBe(VerifiedReason.EVIDENCE_INCOMPLETE);
    expect(out.because).toContain('GET /api/feeds → 502');
  });

  it('reaches flow replay through stepEffect', () => {
    const events = fieldWindow();
    const effect = stepEffect(events, { since: ACTION_AT, until: 100 }, { appOrigin: APP });
    expect(effect.contradictions?.map((c) => c.kind)).toContain(
      ContradictionKind.READ_SERVER_FAULT,
    );
  });

  it('downgrades to unknown, never no: the screen may show what was loaded before', () => {
    expect(isAbsenceDerived(ContradictionKind.READ_SERVER_FAULT)).toBe(true);
  });

  it('is still reported when the tab was hidden: hiding cannot make a 5xx', () => {
    const events = [ev(EventType.PAGE_HEALTH, { hidden: true }), ...fieldWindow()];
    expect(found(events)).toContain(ContradictionKind.READ_SERVER_FAULT);
  });
});

describe('what the rule leaves alone', () => {
  it('a third-party 5xx', () => {
    const events = [label(), get('https://cdn.example.com/fonts.json', 503)];
    expect(found(events)).not.toContain(ContradictionKind.READ_SERVER_FAULT);
    expect(verdictOf(events).verified).toBe(Verified.YES);
  });

  it('a dev-tooling request', () => {
    const events = [label(), get('/__nextjs_original-stack-frames', 500)];
    expect(found(events)).not.toContain(ContradictionKind.READ_SERVER_FAULT);
  });

  it('a 4xx: a 401 or 404 probe is often intended', () => {
    const events = [label(), get('/api/me', 401), get('/api/draft', 404)];
    expect(found(events)).not.toContain(ContradictionKind.READ_SERVER_FAULT);
    expect(verdictOf(events).verified).toBe(Verified.YES);
  });

  it('a 5xx before the action window opened', () => {
    const events = [get('/api/feeds', 500, ACTION_AT - 5), label()];
    expect(found(events)).not.toContain(ContradictionKind.READ_SERVER_FAULT);
    expect(verdictOf(events).verified).toBe(Verified.YES);
  });

  it('a 5xx that a later retry of the same url recovered', () => {
    // The app retried and got the data, so the screen can show it. Same rule as recoveredByRetry.
    const events = [get('/api/feeds', 503), get('/api/feeds', 200), label()];
    expect(found(events)).not.toContain(ContradictionKind.READ_SERVER_FAULT);
    expect(verdictOf(events).verified).toBe(Verified.YES);
  });

  it('a read that already failed the same way before the action: a poll, not this action', () => {
    const prior = [get('/api/broken/500', 500, ACTION_AT - 5)];
    const events = [label(), get('/api/broken/500', 500)];
    const kinds = findContradictions(events, { actionSince: ACTION_AT, appOrigin: APP, prior });
    expect(kinds.map((c) => c.kind)).not.toContain(ContradictionKind.READ_SERVER_FAULT);
  });

  it('a window that no action opened (a passive assert)', () => {
    const events = [label(), get('/api/feeds', 500)];
    const kinds = findContradictions(events, { appOrigin: APP }).map((c) => c.kind);
    expect(kinds).not.toContain(ContradictionKind.READ_SERVER_FAULT);
  });

  it('a 5xx that the app shows to the user', () => {
    const events = [
      get('/api/feeds', 500),
      ev(EventType.DOM_ADDED, { role: 'alert', name: 'Could not load feeds. Try again.' }),
    ];
    expect(found(events)).not.toContain(ContradictionKind.READ_SERVER_FAULT);
  });

  it('a 5xx that the step declared it expects', () => {
    const events = [label(), get('/api/feeds', 500)];
    const kinds = findContradictions(events, {
      actionSince: ACTION_AT,
      appOrigin: APP,
      expectedFailures: [{ urlContains: '/api/feeds', status: 500 }],
    }).map((c) => c.kind);
    expect(kinds).not.toContain(ContradictionKind.READ_SERVER_FAULT);
  });
});
