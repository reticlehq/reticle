/**
 * #1531: a store change or an app signal the action caused is the action doing something.
 *
 * A video Pause button calls `pause()`; the app updates its store on the media `pause` event, and
 * the label swap renders a moment later. Inside the target nothing had mutated yet and no request
 * went out, so `didNothing` reported `action-had-no-effect` and the verdict dropped to `unknown`,
 * with `STATE_CHANGE paused false -> true` sitting in the same window. A standalone assert right
 * after said `yes`.
 *
 * The store change and the signal now count, when the SDK attributed them to the action (they
 * carry an `actionId`). Unattributed churn does not: a busy page's background store updates are the
 * measured case the rule was widened for (see "no-effect under ambient churn" in
 * contradictions.test.ts), and a dead click among them must still be reported. Reticle's own
 * `reticle:` signals are instrumentation, not the app reacting, and never count.
 */

import { describe, expect, it } from 'vitest';
import { ContradictionKind, EventAttribution, EventType, type ReticleEvent } from '@reticlehq/core';
import { findContradictions } from './contradictions.js';

let seq = 0;
function ev(type: EventType, data: Record<string, unknown>, attributed: boolean): ReticleEvent {
  seq += 1;
  const base = { t: seq, seq, type, sessionId: 's', data } as unknown as ReticleEvent;
  return attributed ? { ...base, actionId: 'a1', attribution: EventAttribution.WINDOW } : base;
}

const paused = (attributed: boolean): ReticleEvent =>
  ev(EventType.STATE_CHANGE, { name: 'player', path: 'paused', value: true }, attributed);
const signal = (name: string, attributed: boolean): ReticleEvent =>
  ev(EventType.SIGNAL, { name }, attributed);
const scrolled = (): ReticleEvent => ev(EventType.SCROLL_POSITION, {}, false);

const noEffect = (events: ReticleEvent[]): boolean =>
  findContradictions(events, { action: 'click', mutatedWithin: 0 }).some(
    (c) => c.kind === ContradictionKind.ACTION_HAD_NO_EFFECT,
  );

describe('an app-level reaction attributed to the action', () => {
  it('a store change is the action doing something', () => {
    expect(noEffect([paused(true)])).toBe(false);
  });

  it('an app signal is the action doing something', () => {
    expect(noEffect([signal('player:paused', true)])).toBe(false);
  });

  it('counts among other, unattributed churn in the same window', () => {
    expect(noEffect([scrolled(), paused(true), scrolled()])).toBe(false);
  });
});

describe('what still leaves a click with no effect', () => {
  it('an unattributed store change: background churn, not this action', () => {
    expect(noEffect([paused(false)])).toBe(true);
  });

  it('an unattributed app signal', () => {
    expect(noEffect([signal('player:paused', false)])).toBe(true);
  });

  it('a Reticle instrumentation signal, even when attributed', () => {
    expect(noEffect([signal('reticle:hydrated', true)])).toBe(true);
  });

  it('a window with only scroll samples', () => {
    expect(noEffect([scrolled()])).toBe(true);
  });
});
