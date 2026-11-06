import { describe, it, expect, beforeEach } from 'vitest';
import { ElementState } from '@reticlehq/core';
import { matchQuery } from './query.js';

/**
 * #1648: `state: "visible"` reads a painted aria-hidden element as hidden, and there was no way
 * to assert "painted". An element carrying `aria-hidden="true"` (like a decorative WebGL <canvas>
 * or background layer) is painted on screen but excluded from the accessibility tree.
 *
 * `state: "painted"` allows asserting that the element is rendered on screen regardless of ARIA.
 * A `state: "visible"` miss on an element that is painted but hidden only by aria-hidden names it
 * in `hint.ariaHiddenState`.
 */
describe('state: "painted" and ariaHiddenState hint (#1648)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('matches a painted element carrying aria-hidden="true" when asking for state: "painted"', () => {
    document.body.innerHTML =
      '<canvas aria-hidden="true" data-testid="bg" style="width: 100px; height: 100px;"></canvas>';

    const painted = matchQuery({ testid: 'bg' }, ElementState.PAINTED);
    expect(painted.matched).toBe(true);
    expect(painted.count).toBe(1);
    expect(painted.elements[0]?.states).toContain(ElementState.PAINTED);
  });

  it('fails state: "visible" on an aria-hidden canvas, but sets hint.ariaHiddenState', () => {
    document.body.innerHTML =
      '<canvas aria-hidden="true" data-testid="bg" style="width: 100px; height: 100px;"></canvas>';

    const visible = matchQuery({ testid: 'bg' }, ElementState.VISIBLE);
    expect(visible.matched).toBe(false);
    expect(visible.hint?.ariaHiddenState).toBe(true);
  });

  it('does not match state: "painted" when the element is hidden by CSS (display: none)', () => {
    document.body.innerHTML =
      '<canvas aria-hidden="true" data-testid="bg" style="display: none;"></canvas>';

    const painted = matchQuery({ testid: 'bg' }, ElementState.PAINTED);
    expect(painted.matched).toBe(false);
    expect(painted.hint?.ariaHiddenState).toBeUndefined();
  });

  it('does not match state: "painted" when the element is hidden by CSS (visibility: hidden)', () => {
    document.body.innerHTML =
      '<canvas aria-hidden="true" data-testid="bg" style="visibility: hidden;"></canvas>';

    const painted = matchQuery({ testid: 'bg' }, ElementState.PAINTED);
    expect(painted.matched).toBe(false);
    expect(painted.hint?.ariaHiddenState).toBeUndefined();
  });

  it('matches both state: "visible" and state: "painted" on a normal element', () => {
    document.body.innerHTML = '<div data-testid="content">Hello World</div>';

    const visible = matchQuery({ testid: 'content' }, ElementState.VISIBLE);
    expect(visible.matched).toBe(true);

    const painted = matchQuery({ testid: 'content' }, ElementState.PAINTED);
    expect(painted.matched).toBe(true);
  });

  // jsdom has no layout engine. Geometry tests mock getBoundingClientRect / getClientRects
  // the same way `a11y.test.ts` does, so the clipping and collapse paths run correctly.

  it('does not match state: "painted" for a 0×0 canvas', () => {
    document.body.innerHTML =
      '<canvas aria-hidden="true" data-testid="bg" style="width: 0; height: 0;"></canvas>';
    const el = document.querySelector('[data-testid="bg"]') as HTMLElement;
    el.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
    el.getClientRects = () => [new DOMRect(0, 0, 0, 0)] as unknown as DOMRectList;

    const painted = matchQuery({ testid: 'bg' }, ElementState.PAINTED);
    expect(painted.matched).toBe(false);
  });

  it('does not match state: "painted" for a canvas inside an overflow:hidden; height:0 parent', () => {
    document.body.innerHTML =
      '<div style="overflow: hidden; overflow-x: hidden; overflow-y: hidden; height: 0;"><canvas aria-hidden="true" data-testid="bg" style="width: 100px; height: 100px;"></canvas></div>';
    const parent = document.querySelector('div') as HTMLElement;
    const el = document.querySelector('[data-testid="bg"]') as HTMLElement;
    parent.getBoundingClientRect = () => new DOMRect(0, 0, 100, 0);
    el.getBoundingClientRect = () => new DOMRect(0, 0, 100, 100);

    const painted = matchQuery({ testid: 'bg' }, ElementState.PAINTED);
    expect(painted.matched).toBe(false);
  });

  it('sets hint.ariaHiddenState for state: "inViewport" when candidate is inside the viewport', () => {
    document.body.innerHTML =
      '<canvas aria-hidden="true" data-testid="bg" style="width: 100px; height: 100px;"></canvas>';
    const el = document.querySelector('[data-testid="bg"]') as HTMLElement;
    el.getBoundingClientRect = () => new DOMRect(10, 10, 100, 100);

    const result = matchQuery({ testid: 'bg' }, ElementState.IN_VIEWPORT);
    expect(result.matched).toBe(false);
    expect(result.hint?.ariaHiddenState).toBe(true);
  });

  it('does not set hint.ariaHiddenState for state: "inViewport" when candidate is outside the viewport', () => {
    document.body.innerHTML =
      '<canvas aria-hidden="true" data-testid="bg" style="width: 100px; height: 100px;"></canvas>';
    const el = document.querySelector('[data-testid="bg"]') as HTMLElement;
    // Position below the viewport fold (innerHeight is 768 in jsdom)
    el.getBoundingClientRect = () => new DOMRect(10, 2000, 100, 100);

    const result = matchQuery({ testid: 'bg' }, ElementState.IN_VIEWPORT);
    expect(result.matched).toBe(false);
    expect(result.hint?.ariaHiddenState).toBeUndefined();
  });

  it('does not set hint.ariaHiddenState on an element without aria-hidden', () => {
    document.body.innerHTML =
      '<div style="overflow: hidden; overflow-x: hidden; overflow-y: hidden; height: 50px;"><div data-testid="row" style="height: 100px;">row</div></div>';
    const parent = document.querySelector('div') as HTMLElement;
    const el = document.querySelector('[data-testid="row"]') as HTMLElement;
    parent.getBoundingClientRect = () => new DOMRect(0, 0, 100, 50);
    el.getBoundingClientRect = () => new DOMRect(0, 100, 100, 50);

    const result = matchQuery({ testid: 'row' }, ElementState.IN_VIEWPORT);
    expect(result.matched).toBe(false);
    expect(result.hint?.ariaHiddenState).toBeUndefined();
  });
});
