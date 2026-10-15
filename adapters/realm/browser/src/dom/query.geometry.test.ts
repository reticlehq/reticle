import { describe, it, expect, beforeEach } from 'vitest';
import { matchQuery } from './query.js';

/**
 * Geometry evidence for element predicates (#1539): measured here, graded by the engine.
 *
 * `reticle_look` already reports the box; a predicate could not assert on it, so "fully on
 * screen", "does not overlap" and "text is not cut off" had no verdict. When a MATCH asks for
 * geometry, each described element carries its measured box, the viewport, whether the whole
 * box survives the viewport and every clipping ancestor, and how much text a clipping box cuts.
 */

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

function rectOf(el: Element, r: Box): void {
  el.getBoundingClientRect = () => new DOMRect(r.x, r.y, r.width, r.height);
}

function setViewport(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true });
}

function byTestid(id: string): HTMLElement {
  const el = document.querySelector(`[data-testid="${id}"]`);
  if (!(el instanceof HTMLElement)) throw new Error(`no element for ${id}`);
  return el;
}

describe('matchQuery geometry evidence', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    setViewport(800, 600);
  });

  it('reports the box fully in the viewport at a wide viewport', () => {
    document.body.innerHTML = '<div data-testid="card">Card</div>';
    rectOf(byTestid('card'), { x: 10, y: 10, width: 200, height: 50 });
    const match = matchQuery({ testid: 'card' }, undefined, undefined, undefined, undefined, {});
    const geometry = match.elements[0]?.geometry;
    expect(geometry?.box).toEqual({ x: 10, y: 10, width: 200, height: 50 });
    expect(geometry?.viewport).toEqual({ width: 800, height: 600 });
    expect(geometry?.fullyInViewport).toBe(true);
  });

  it('reports the same box as not fully in a narrow viewport', () => {
    setViewport(150, 600);
    document.body.innerHTML = '<div data-testid="card">Card</div>';
    rectOf(byTestid('card'), { x: 10, y: 10, width: 200, height: 50 });
    const match = matchQuery({ testid: 'card' }, undefined, undefined, undefined, undefined, {});
    expect(match.elements[0]?.geometry?.fullyInViewport).toBe(false);
  });

  it('reports a box cut by a clipping ancestor as not fully in the viewport', () => {
    document.body.innerHTML =
      '<div id="clip" style="overflow-x: hidden; overflow-y: hidden"><div data-testid="card">Card</div></div>';
    rectOf(byTestid('card'), { x: 0, y: 0, width: 200, height: 50 });
    const clip = document.getElementById('clip');
    if (null === clip) throw new Error('no clip element');
    rectOf(clip, { x: 0, y: 0, width: 100, height: 600 });
    const match = matchQuery({ testid: 'card' }, undefined, undefined, undefined, undefined, {});
    expect(match.elements[0]?.geometry?.fullyInViewport).toBe(false);
  });

  it('measures text a clipping box cuts off, in pixels', () => {
    document.body.innerHTML =
      '<span data-testid="label" style="overflow-x: hidden">A very long label</span>';
    const label = byTestid('label');
    Object.defineProperty(label, 'scrollWidth', { value: 220, configurable: true });
    Object.defineProperty(label, 'clientWidth', { value: 100, configurable: true });
    const match = matchQuery({ testid: 'label' }, undefined, undefined, undefined, undefined, {});
    const geometry = match.elements[0]?.geometry;
    expect(geometry?.textClipped).toBe(true);
    expect(geometry?.clippedX).toBe(120);
  });

  it('reports no clipping for text that fits', () => {
    document.body.innerHTML = '<span data-testid="label">Short</span>';
    const match = matchQuery({ testid: 'label' }, undefined, undefined, undefined, undefined, {});
    expect(match.elements[0]?.geometry?.textClipped).toBe(false);
  });

  it('reports whether the box intersects another element the caller names', () => {
    document.body.innerHTML =
      '<div data-testid="card">Card</div><div data-testid="other">Other</div>';
    rectOf(byTestid('card'), { x: 0, y: 0, width: 100, height: 100 });
    rectOf(byTestid('other'), { x: 50, y: 50, width: 100, height: 100 });
    const match = matchQuery({ testid: 'card' }, undefined, undefined, undefined, undefined, {
      overlaps: { testid: 'other' },
    });
    const overlap = match.elements[0]?.geometry?.overlap;
    expect(overlap?.intersects).toBe(true);
    expect(overlap?.box).toEqual({ x: 50, y: 50, width: 100, height: 100 });
  });

  it('reports no intersection for boxes apart, and no overlap fact when the other is absent', () => {
    document.body.innerHTML =
      '<div data-testid="card">Card</div><div data-testid="other">Other</div>';
    rectOf(byTestid('card'), { x: 0, y: 0, width: 100, height: 100 });
    rectOf(byTestid('other'), { x: 300, y: 300, width: 50, height: 50 });
    const apart = matchQuery({ testid: 'card' }, undefined, undefined, undefined, undefined, {
      overlaps: { testid: 'other' },
    });
    expect(apart.elements[0]?.geometry?.overlap?.intersects).toBe(false);

    const missing = matchQuery({ testid: 'card' }, undefined, undefined, undefined, undefined, {
      overlaps: { testid: 'missing' },
    });
    expect(missing.elements[0]?.geometry?.overlap).toBeUndefined();
  });

  it('reports a hidden element as not fully in the viewport instead of throwing', () => {
    document.body.innerHTML = '<div data-testid="card" style="display: none">Card</div>';
    rectOf(byTestid('card'), { x: 10, y: 10, width: 200, height: 50 });
    const match = matchQuery({ testid: 'card' }, undefined, undefined, undefined, undefined, {});
    expect(match.elements[0]?.geometry?.fullyInViewport).toBe(false);
  });

  it('stamps no geometry when the match did not ask for it', () => {
    document.body.innerHTML = '<div data-testid="card">Card</div>';
    const match = matchQuery({ testid: 'card' });
    expect(match.elements[0]?.geometry).toBeUndefined();
  });
});
