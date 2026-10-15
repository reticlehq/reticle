/**
 * #1531: a store change or an app signal TIED to the action is the action doing something.
 *
 * A video Pause button calls `pause()`; the app updates its store on the media `pause` event, and
 * the label swap renders a moment later. Inside the target nothing had mutated yet and no request
 * went out, so `didNothing` reported `action-had-no-effect` with `STATE_CHANGE paused false -> true`
 * in the same window.
 *
 * Being in the window is not enough to count. The session stamps the active action's id on every
 * event between dispatch and settle, so background churn inside the act window carries an
 * `actionId` too, and a dead click on a busy page must still be reported. A change counts only
 * when the caller's predicate named it, or when it was quiet before the action (nothing in `prior`
 * moved that path or fired that signal). Every fixture below carries an `actionId`, as production
 * stamps them.
 */

import { describe, expect, it } from 'vitest';
import { ContradictionKind, EventAttribution, EventType, type ReticleEvent } from '@reticlehq/core';
import { findContradictions } from './contradictions.js';
import type { ContradictionOptions } from './contradiction-types.js';

let seq = 0;
function ev(type: EventType, data: Record<string, unknown>): ReticleEvent {
  seq += 1;
  return {
    t: seq,
    seq,
    type,
    sessionId: 's',
    data,
    actionId: 'a1',
    attribution: EventAttribution.WINDOW,
  };
}

const state = (path: string): ReticleEvent =>
  ev(EventType.STATE_CHANGE, { name: 'app', path, value: seq });
const signal = (name: string): ReticleEvent => ev(EventType.SIGNAL, { name });
const scrolled = (): ReticleEvent => ev(EventType.SCROLL_POSITION, {});

const noEffect = (events: ReticleEvent[], extra: Partial<ContradictionOptions> = {}): boolean =>
  findContradictions(events, { action: 'click', mutatedWithin: 0, ...extra }).some(
    (c) => c.kind === ContradictionKind.ACTION_HAD_NO_EFFECT,
  );

/** A page whose `rows` store path and `tick` signal were already churning before the action. */
const busyPrior = [state('rows'), signal('feed:tick'), scrolled(), state('rows')];

describe('a store change or signal tied to the action counts', () => {
  it('a store path the until clause named', () => {
    expect(noEffect([state('player.paused')], { namedStatePaths: ['player.paused'] })).toBe(false);
  });

  it('a named store path counts even if it was moving before', () => {
    expect(noEffect([state('rows')], { namedStatePaths: ['rows'], prior: busyPrior })).toBe(false);
  });

  it('a signal the until clause named', () => {
    expect(noEffect([signal('player:paused')], { namedSignals: ['player:paused'] })).toBe(false);
  });

  it('an unnamed store path that was quiet before the action', () => {
    expect(noEffect([state('player.paused'), scrolled()], { prior: busyPrior })).toBe(false);
  });

  it('an unnamed app signal that was quiet before the action', () => {
    expect(noEffect([signal('player:paused')], { prior: busyPrior })).toBe(false);
  });
});

describe('background churn in the act window, attributed as production stamps it, still leaves a dead click', () => {
  it('a store path that was already moving before the action', () => {
    expect(noEffect([state('rows'), scrolled()], { prior: busyPrior })).toBe(true);
  });

  it('a signal that was already firing before the action', () => {
    expect(noEffect([signal('feed:tick')], { prior: busyPrior })).toBe(true);
  });

  it('an unnamed store change with no prior history to judge it by', () => {
    expect(noEffect([state('player.paused')])).toBe(true);
  });

  it('a Reticle instrumentation signal, even named nowhere and quiet before', () => {
    expect(noEffect([signal('reticle:hydrated')], { prior: busyPrior })).toBe(true);
  });

  it('a named path that did not move does not rescue a different one', () => {
    expect(
      noEffect([state('rows')], { namedStatePaths: ['player.paused'], prior: busyPrior }),
    ).toBe(true);
  });
});
