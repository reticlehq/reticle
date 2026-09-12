import { afterEach, describe, expect, it } from 'vitest';
import { hitTestOccluder } from './occlusion.js';

/** jsdom has no layout, so elementFromPoint doesn't exist — install a controllable stub. */
function stubTopElement(ret: Element | null): void {
  Object.defineProperty(document, 'elementFromPoint', {
    value: () => ret,
    configurable: true,
    writable: true,
  });
}

describe('hitTestOccluder', () => {
  afterEach(() => {
    Reflect.deleteProperty(document, 'elementFromPoint');
    document.body.innerHTML = '';
  });

  it('returns null for a zero-area rect (a size bug, not an occlusion)', () => {
    const el = document.createElement('button');
    expect(hitTestOccluder(el, new DOMRect(0, 0, 0, 0))).toBeNull();
  });

  it('returns null when the environment cannot hit-test (no elementFromPoint)', () => {
    const el = document.createElement('button');
    expect(hitTestOccluder(el, new DOMRect(0, 0, 10, 10))).toBeNull();
  });

  it('returns the foreign element covering the center as the occluder', () => {
    const el = document.createElement('button');
    const overlay = document.createElement('div');
    document.body.append(el, overlay);
    stubTopElement(overlay);
    expect(hitTestOccluder(el, new DOMRect(0, 0, 10, 10))).toBe(overlay);
  });

  it('is not occluded when the target itself, an ancestor, or a descendant is on top', () => {
    const wrapper = document.createElement('div');
    const el = document.createElement('button');
    const child = document.createElement('span');
    el.append(child);
    wrapper.append(el);
    document.body.append(wrapper);
    const rect = new DOMRect(0, 0, 10, 10);
    stubTopElement(el);
    expect(hitTestOccluder(el, rect)).toBeNull(); // itself
    stubTopElement(wrapper);
    expect(hitTestOccluder(el, rect)).toBeNull(); // ancestor wrapping it
    stubTopElement(child);
    expect(hitTestOccluder(el, rect)).toBeNull(); // descendant
  });

  it("never treats Reticle's own UI as an occluder", () => {
    const el = document.createElement('button');
    const hud = document.createElement('div');
    hud.setAttribute('data-reticle-overlay', '');
    document.body.append(el, hud);
    stubTopElement(hud);
    expect(hitTestOccluder(el, new DOMRect(0, 0, 10, 10))).toBeNull();
  });
});

/**
 * Sample more than the centre pixel.
 *
 * MEASURED: two bugs in this repo's own detection suite — `occluded` and `cmdk-occluded` — were
 * missed because the hit test asked about one point. An overlay that covers a control but happens to
 * miss its exact centre was invisible, and "covers it except for one pixel" is not a thing a user
 * can click through.
 *
 * The opposite failure is the one to fear, because this repo's cardinal metric is zero false
 * positives: partial overlap is NOT occlusion. A tooltip clipping one corner, a focus ring, a
 * sticky header grazing the top edge — all leave a usable control, and reporting them would teach
 * agents to ignore the finding. So the rule is a MAJORITY of sampled points, not any of them.
 */
function stubPerPoint(map: (x: number, y: number) => Element | null): void {
  Object.defineProperty(document, 'elementFromPoint', {
    value: (x: number, y: number) => map(x, y),
    configurable: true,
    writable: true,
  });
}

describe('hitTestOccluder samples more than the centre', () => {
  afterEach(() => {
    Reflect.deleteProperty(document, 'elementFromPoint');
    document.body.innerHTML = '';
  });

  it('catches an overlay that covers the control but misses the exact centre', () => {
    const el = document.createElement('button');
    const overlay = document.createElement('div');
    document.body.append(el, overlay);
    const rect = new DOMRect(0, 0, 100, 100);
    // Everything is the overlay EXCEPT the single centre point — the shape that was invisible.
    stubPerPoint((x, y) => (50 === x && 50 === y ? el : overlay));
    expect(hitTestOccluder(el, rect)).toBe(overlay);
  });

  it('does NOT report occlusion for partial overlap — a clipped corner is still clickable', () => {
    const el = document.createElement('button');
    const tooltip = document.createElement('div');
    document.body.append(el, tooltip);
    const rect = new DOMRect(0, 0, 100, 100);
    // One sampled corner only. Four of five points reach the control.
    stubPerPoint((x, y) => (x < 30 && y < 30 ? tooltip : el));
    expect(hitTestOccluder(el, rect)).toBeNull();
  });

  it('still reports a full-cover overlay, as it always did', () => {
    const el = document.createElement('button');
    const overlay = document.createElement('div');
    document.body.append(el, overlay);
    stubPerPoint(() => overlay);
    expect(hitTestOccluder(el, new DOMRect(0, 0, 100, 100))).toBe(overlay);
  });
});
