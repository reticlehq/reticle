/**
 * #2318: a text or attribute change ON the acted control is the action doing something.
 *
 * A Copy button swaps its own label to "Copied" after the clipboard write resolves — a moment
 * after the act's bounded settle ended. The in-page counter had already disconnected, so
 * `domMutatedWithin` was 0, no request went out and `didNothing` reported `action-had-no-effect`
 * while the window held the DOM_TEXT event that showed the label change.
 *
 * The event channel sees what the counter timed out on. A mutation ON the target's own ref is the
 * same signal `domMutatedWithin` measures, arriving late. Churn on OTHER elements still does not
 * count — that is the ambient noise the in-target measurement exists to exclude.
 */

import { describe, expect, it } from 'vitest';
import { ContradictionKind, EventAttribution, EventType, type ReticleEvent } from '@reticlehq/core';
import { findContradictions } from './contradictions.js';
import type { ContradictionOptions } from './contradiction-types.js';

let seq = 0;
function ev(type: EventType, data: Record<string, unknown>, ref?: string): ReticleEvent {
  seq += 1;
  return {
    t: seq,
    seq,
    type,
    sessionId: 's',
    data,
    actionId: 'a1',
    attribution: EventAttribution.WINDOW,
    ...(ref === undefined ? {} : { ref }),
  };
}

const noEffect = (events: ReticleEvent[], extra: Partial<ContradictionOptions> = {}): boolean =>
  findContradictions(events, {
    action: 'click',
    mutatedWithin: 0,
    ref: 'e7',
    ...extra,
  }).some((c) => c.kind === ContradictionKind.ACTION_HAD_NO_EFFECT);

describe('a mutation on the acted control counts as an effect (#2318)', () => {
  it('a label swap on the clicked element, landing after the settle window closed', () => {
    expect(noEffect([ev(EventType.DOM_TEXT, { text: 'Copied', old: 'Copy code' }, 'e7')])).toBe(
      false,
    );
  });

  it('an attribute change on the clicked element (aria-expanded on a disclosure button)', () => {
    expect(noEffect([ev(EventType.DOM_ATTR, { attr: 'aria-expanded', value: 'true' }, 'e7')])).toBe(
      false,
    );
  });

  it('a label swap in a child SPAN of the clicked element — the common markup', () => {
    // <button ref=e7><span ref=e12>Copy code</span></button>: the observer reports the span's
    // ref and names its minted ancestors in `inside`.
    expect(
      noEffect([
        ev(EventType.DOM_TEXT, { text: 'Copied', old: 'Copy code', inside: ['e7'] }, 'e12'),
      ]),
    ).toBe(false);
  });

  it('a state attribute on a descendant of the clicked element', () => {
    expect(
      noEffect([
        ev(EventType.DOM_ATTR, { attr: 'aria-selected', value: 'true', inside: ['e7'] }, 'e12'),
      ]),
    ).toBe(false);
  });
});

describe('churn that is not on the target still leaves a dead click', () => {
  it('a text change on another element', () => {
    expect(noEffect([ev(EventType.DOM_TEXT, { text: 'Copied', old: 'Copy code' }, 'e12')])).toBe(
      true,
    );
  });

  it('an attribute change on another element', () => {
    expect(
      noEffect([ev(EventType.DOM_ATTR, { attr: 'aria-expanded', value: 'true' }, 'e12')]),
    ).toBe(true);
  });

  it('a change inside a DIFFERENT control — inside names an ancestor that was not acted', () => {
    expect(
      noEffect([ev(EventType.DOM_TEXT, { text: 'Saved', old: 'Save', inside: ['e9'] }, 'e12')]),
    ).toBe(true);
  });
});

describe('press furniture still leaves a dead click (#2387)', () => {
  it('a data-pressed toggle on the clicked element itself', () => {
    expect(noEffect([ev(EventType.DOM_ATTR, { attr: 'data-pressed', value: 'true' }, 'e7')])).toBe(
      true,
    );
  });

  it('a class change on the clicked element', () => {
    expect(noEffect([ev(EventType.DOM_ATTR, { attr: 'class', value: 'btn ripple' }, 'e7')])).toBe(
      true,
    );
  });

  it('a ripple child changing class inside the clicked element', () => {
    expect(
      noEffect([
        ev(EventType.DOM_ATTR, { attr: 'class', value: 'rippling', inside: ['e7'] }, 'e12'),
      ]),
    ).toBe(true);
  });

  it('a data-focused attribute inside the clicked element', () => {
    expect(
      noEffect([
        ev(EventType.DOM_ATTR, { attr: 'data-focused', value: '', inside: ['e7'] }, 'e12'),
      ]),
    ).toBe(true);
  });
});
