import { describe, expect, it } from 'vitest';
import { ContradictionKind, EventType, type ReticleEvent } from '@reticlehq/core';
import { stepEffect } from './step-effect.js';

/**
 * One window of events, one effect record — built the SAME way for a driven step and a replayed one.
 *
 * The two paths computed this separately and were already drifting: the live act path returned a
 * reaction digest and contradictions, the replay path returned a prose sentence. A step that a
 * person drives and the same step replayed an hour later described what happened in two different
 * vocabularies, which makes the before/after comparison this product exists for impossible to read.
 */
function ev(t: number, type: EventType, data: Record<string, unknown> = {}): ReticleEvent {
  return { t, seq: t, type, sessionId: 's', data };
}

const CLICK_THAT_MOVED_THE_UI_OVER_A_FAILED_WRITE: ReticleEvent[] = [
  ev(1, EventType.DOM_REMOVED, { path: 'li' }),
  ev(2, EventType.NET_REQUEST, {
    id: 'n2',
    method: 'POST',
    url: '/api/archive',
    status: 500,
    ok: false,
  }),
];

describe('the effect record for one window', () => {
  it('carries the window as a bounded pair — the drill address', () => {
    const effect = stepEffect(CLICK_THAT_MOVED_THE_UI_OVER_A_FAILED_WRITE, { since: 0, until: 40 });
    expect(effect.window).toEqual({ since: 0, until: 40 });
  });

  it('carries the counts, not the timeline', () => {
    const effect = stepEffect(CLICK_THAT_MOVED_THE_UI_OVER_A_FAILED_WRITE, { since: 0, until: 40 });
    expect(effect.digest?.summary.network).toBe(1);
    expect(effect.digest?.summary.domRemoved).toBe(1);
    expect(effect.digest).not.toHaveProperty('events');
  });

  it('carries the disagreement between channels', () => {
    const effect = stepEffect(CLICK_THAT_MOVED_THE_UI_OVER_A_FAILED_WRITE, { since: 0, until: 40 });
    expect(effect.contradictions?.map((c) => c.kind)).toContain(
      ContradictionKind.UI_ADVANCED_REQUEST_FAILED,
    );
  });

  it('omits contradictions when the channels agree, rather than sending an empty list', () => {
    // Its presence is the signal. A field that is always there gets skimmed past.
    const effect = stepEffect([ev(1, EventType.DOM_REMOVED, { path: 'li' })], {
      since: 0,
      until: 40,
    });
    expect(effect.contradictions).toBeUndefined();
  });

  it('does not treat a cross-site write as a response the page ignored', () => {
    const analytics = ev(1, EventType.NET_REQUEST, {
      id: 'a1',
      method: 'POST',
      url: 'https://analytics.example/collect',
      status: 204,
      ok: true,
    });
    const blind = stepEffect([analytics], { since: 0, until: 40 });
    expect(blind.contradictions?.map((c) => c.kind)).toContain(ContradictionKind.RESPONSE_IGNORED);
    const effect = stepEffect(
      [analytics],
      { since: 0, until: 40 },
      {
        appOrigin: 'http://localhost:5173/',
        background: [],
      },
    );
    expect(effect.contradictions).toBeUndefined();
  });

  it('still reports a first-party write the page ignored', () => {
    const effect = stepEffect(
      [
        ev(1, EventType.NET_REQUEST, {
          id: 'n1',
          method: 'POST',
          url: '/api/save',
          status: 204,
          ok: true,
        }),
      ],
      { since: 0, until: 40 },
      { appOrigin: 'http://localhost:5173/', background: [] },
    );
    expect(effect.contradictions?.map((c) => c.kind)).toContain(ContradictionKind.RESPONSE_IGNORED);
  });

  describe('a failure the step declared', () => {
    const REFUSED_SAVE: ReticleEvent[] = [
      ev(1, EventType.DOM_ADDED, { path: 'p.refusal' }),
      ev(2, EventType.NET_REQUEST, {
        id: 'n3',
        method: 'POST',
        url: '/api/save',
        status: 409,
        ok: false,
      }),
    ];

    it('is not a contradiction when the step expects it', () => {
      const effect = stepEffect(
        REFUSED_SAVE,
        { since: 0, until: 40 },
        { declared: [{ kind: 'net', method: 'POST', status: 409 }] },
      );
      expect(effect.contradictions?.map((c) => c.kind) ?? []).not.toContain(
        ContradictionKind.UI_ADVANCED_REQUEST_FAILED,
      );
    });

    it('is still a contradiction when the step did not declare it', () => {
      const effect = stepEffect(REFUSED_SAVE, { since: 0, until: 40 }, { declared: [] });
      expect(effect.contradictions?.map((c) => c.kind)).toContain(
        ContradictionKind.UI_ADVANCED_REQUEST_FAILED,
      );
    });
  });

  it('omits the window where no clock advanced, rather than claiming a zero-width one', () => {
    const effect = stepEffect([], { since: 7, until: 7 });
    expect(effect.window).toBeUndefined();
  });
});
