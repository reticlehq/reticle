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
