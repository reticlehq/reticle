import { describe, expect, it } from 'vitest';
import { EventType, type ReticleEvent } from '@reticlehq/core';
import {
  accumulateAmbient,
  excludeAmbient,
  isAmbient,
  ambientKeyOf,
  DEFAULT_AMBIENT_THRESHOLD,
  isStableAmbientKey,
  onlyStableAmbient,
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

/**
 * A ref means nothing in the next session, so it must never be learned ACROSS one.
 *
 * MEASURED on bench-app. `regionKeyOf` prefers the nearest `data-testid` and falls back to the
 * element's ref when there is none — and a ref is a per-session sequence number, so `e404` addresses
 * one element today and a different one tomorrow. The map is persisted and re-seeded into every new
 * session, so a fresh session inherited suppression aimed at elements it had never seen.
 *
 * What that cost: real, action-caused DOM events vanished from the window. A crawl then reported
 * `state-vs-render` on a ⌘K button whose click demonstrably mounted the palette — the store moved,
 * React committed, and the DOM events were filtered out before anything could see them. Deleting
 * `.reticle/ambient.json` and re-driving the identical click took `domChanged` from 0 to 7.
 *
 * In-session learning by ref is untouched: within one session a ref IS an identity, and a churning
 * region with no testid is exactly what it was built for. Only the crossing is wrong.
 */
describe('only a stable key survives between sessions', () => {
  it('treats a bare element ref as unstable', () => {
    for (const ref of ['e1', 'e404', 'e1310']) expect(isStableAmbientKey(ref)).toBe(false);
  });

  it('treats a testid as stable, including ones that merely look ref-ish', () => {
    for (const id of ['activity-feed', 'e2e-panel', 'eel', 'e12x', 'row-3700']) {
      expect(isStableAmbientKey(id), id).toBe(true);
    }
  });

  it('keeps only the stable counts when a map crosses a session boundary', () => {
    expect(onlyStableAmbient({ e404: 39, 'activity-feed': 25, e1: 2, ticker: 30 })).toEqual({
      'activity-feed': 25,
      ticker: 30,
    });
  });

  it('is empty rather than wrong when everything learned was ref-keyed', () => {
    expect(onlyStableAmbient({ e404: 39, e405: 43 })).toEqual({});
  });
});
