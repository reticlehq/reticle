import { describe, expect, it } from 'vitest';
import { EventType, type ReticleEvent } from '@reticlehq/core';
import {
  accumulateAmbient,
  excludeAmbient,
  isAmbient,
  ambientKeyOf,
  DEFAULT_AMBIENT_THRESHOLD,
} from './ambient.js';

function evt(ref: string | undefined, actionId?: string): ReticleEvent {
  return {
    t: 0,
    seq: 0,
    type: EventType.DOM_ADDED,
    sessionId: 'demo',
    data: {},
    ...(ref === undefined ? {} : { ref }),
    ...(actionId === undefined ? {} : { actionId }),
  };
}

describe('ambient learning', () => {
  it('counts only unattributed, ref-bearing churn', () => {
    const counts = accumulateAmbient({}, [
      evt('chat'),
      evt('chat'),
      evt('chat', 'a1'), // attributed → not ambient
      evt(undefined), // no ref → ignored
    ]);
    expect(counts['chat']).toBe(2);
  });

  it('flags a ref as ambient once it passes the threshold', () => {
    let counts = {};
    const churn = Array.from({ length: DEFAULT_AMBIENT_THRESHOLD }, () => evt('ticker'));
    counts = accumulateAmbient(counts, churn);
    expect(isAmbient(counts, 'ticker')).toBe(true);
    expect(isAmbient(counts, 'submit-btn')).toBe(false);
    expect(isAmbient(counts, undefined)).toBe(false);
  });

  it('excludes ambient churn but keeps non-ambient and action-attributed events', () => {
    const counts = { ticker: 999 };
    const events = [evt('ticker'), evt('submit-btn'), evt('ticker', 'a1')];
    const kept = excludeAmbient(counts, events);
    // ambient ticker churn dropped; the button survives, and so does the action-attributed ticker event
    expect(kept.map((e) => e.ref)).toEqual(['submit-btn', 'ticker']);
    expect(kept[1]?.actionId).toBe('a1');
  });
});

describe('ambientKeyOf — a churning FEED must converge (the ref-keying flaw)', () => {
  const ev = (type: EventType, ref: string | undefined, region?: string): ReticleEvent => ({
    t: 1,
    type,
    sessionId: 's',
    ...(ref === undefined ? {} : { ref }),
    data: region === undefined ? {} : { region },
  });

  it('keys on the stable region, not the per-element ref', () => {
    // A feed appends a NEW element each tick (fresh ref) and removals carry no ref at all, so per-ref
    // counts never accumulate and the region is never learned as ambient — settle then never fires.
    expect(ambientKeyOf(ev(EventType.DOM_ADDED, 'e808', 'hostile-feed'))).toBe('hostile-feed');
    expect(ambientKeyOf(ev(EventType.DOM_REMOVED, undefined, 'hostile-feed'))).toBe('hostile-feed');
  });

  it('falls back to the ref when no region is present (a single mutating element)', () => {
    expect(ambientKeyOf(ev(EventType.DOM_TEXT, 'e6'))).toBe('e6');
  });

  it('a churning feed converges to ambient even though every ref differs', () => {
    let counts = {};
    for (let i = 0; i < 25; i++) {
      counts = accumulateAmbient(counts, [
        ev(EventType.DOM_ADDED, `e${String(800 + i)}`, 'hostile-feed'),
        ev(EventType.DOM_REMOVED, undefined, 'hostile-feed'),
      ]);
    }
    expect(isAmbient(counts, 'hostile-feed')).toBe(true);
  });
});
