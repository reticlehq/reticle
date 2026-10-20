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
      '<div data-testid="label" style="overflow-x: hidden">A very long label</div>';
    const label = byTestid('label');
    Object.defineProperty(label, 'scrollWidth', { value: 220, configurable: true });
    Object.defineProperty(label, 'clientWidth', { value: 100, configurable: true });
    const match = matchQuery({ testid: 'label' }, undefined, undefined, undefined, undefined, {});
    const geometry = match.elements[0]?.geometry;
    expect(geometry?.textClipped).toBe(true);
    expect(geometry?.clippedX).toBe(120);
  });

  it('reads inline text at the nearest clipping ancestor, not at the span', () => {
    // Review case on #1635: overflow does not apply to an inline box, so the span's own widths
    // read 0 while the div around it cuts the text. Measuring the span would pass a cut-off label.
    document.body.innerHTML =
      '<div data-testid="clip" style="overflow-x: hidden"><span data-testid="label">A very long label</span></div>';
    const clip = byTestid('clip');
    Object.defineProperty(clip, 'scrollWidth', { value: 220, configurable: true });
    Object.defineProperty(clip, 'clientWidth', { value: 100, configurable: true });
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

  it('does not read a clipping parent as clipped for a block that fits', () => {
    // Review case on #1635: the walk used to go past a block that does not clip, up to any
    // ancestor that does. A short <li> in an overflow-x: hidden carousel then reported the
    // overflow of the whole list as its own. The block's own box decides: it fits, so
    // nothing is clipped.
    document.body.innerHTML =
      '<ul data-testid="list" style="overflow-x: hidden"><li data-testid="item">Short</li></ul>';
    const list = byTestid('list');
    Object.defineProperty(list, 'scrollWidth', { value: 400, configurable: true });
    Object.defineProperty(list, 'clientWidth', { value: 100, configurable: true });
    const item = byTestid('item');
    Object.defineProperty(item, 'scrollWidth', { value: 50, configurable: true });
    Object.defineProperty(item, 'clientWidth', { value: 50, configurable: true });
    const match = matchQuery({ testid: 'item' }, undefined, undefined, undefined, undefined, {});
    const geometry = match.elements[0]?.geometry;
    expect(geometry?.textClipped).toBe(false);
    expect(geometry?.clippedX).toBe(0);
  });

  it('skips an inline box when finding the nearest clipping box', () => {
    // Review case on #1635: a Tailwind `truncate` span carries `overflow: hidden` in its
    // computed style, but overflow does not apply to an inline box, so the span's own widths
    // read 0 while the div around it cuts the text. The walk must skip the span and read the div.
    document.body.innerHTML =
      '<div data-testid="clip" style="overflow-x: hidden">' +
      '<span data-testid="label" style="display: inline; overflow-x: hidden; text-overflow: ellipsis; white-space: nowrap">A very long label</span></div>';
    const clip = byTestid('clip');
    Object.defineProperty(clip, 'scrollWidth', { value: 220, configurable: true });
    Object.defineProperty(clip, 'clientWidth', { value: 100, configurable: true });
    const match = matchQuery({ testid: 'label' }, undefined, undefined, undefined, undefined, {});
    const geometry = match.elements[0]?.geometry;
    expect(geometry?.textClipped).toBe(true);
    expect(geometry?.clippedX).toBe(120);
  });

  it('skips a display: contents box when finding the nearest clipping box', () => {
    // A `display: contents` box has no box of its own: its widths read 0 and it clips nothing.
    document.body.innerHTML =
      '<div data-testid="clip" style="overflow-x: hidden">' +
      '<span data-testid="wrap" style="display: contents; overflow-x: hidden"><span data-testid="label">A very long label</span></span></div>';
    const clip = byTestid('clip');
    Object.defineProperty(clip, 'scrollWidth', { value: 220, configurable: true });
    Object.defineProperty(clip, 'clientWidth', { value: 100, configurable: true });
    const match = matchQuery({ testid: 'label' }, undefined, undefined, undefined, undefined, {});
    const geometry = match.elements[0]?.geometry;
    expect(geometry?.textClipped).toBe(true);
    expect(geometry?.clippedX).toBe(120);
  });

  it('ignores text-overflow: ellipsis without an overflow that clips', () => {
    // Review case on #1635: `text-overflow: ellipsis` has no effect without `overflow: hidden`,
    // so the declaration alone must not read as a clip.
    document.body.innerHTML =
      '<div data-testid="label" style="text-overflow: ellipsis">A very long label</div>';
    const label = byTestid('label');
    Object.defineProperty(label, 'scrollWidth', { value: 220, configurable: true });
    Object.defineProperty(label, 'clientWidth', { value: 100, configurable: true });
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

  it('measures overlap against the first visible match, not a hidden twin', () => {
    // Review case on #1635: candidates arrive in document order, hidden or not. The hidden twin
    // sits exactly on the card; measuring it would report an intersection with a box nobody sees.
    document.body.innerHTML =
      '<div data-testid="card">Card</div>' +
      '<div data-testid="other" style="display: none">Hidden</div>' +
      '<div data-testid="other">Shown</div>';
    rectOf(byTestid('card'), { x: 0, y: 0, width: 100, height: 100 });
    const twins = Array.from(document.querySelectorAll('[data-testid="other"]'));
    const [hidden, shown] = twins;
    if (2 !== twins.length || hidden === undefined || shown === undefined) {
      throw new Error('no hidden/shown twins');
    }
    rectOf(hidden, { x: 0, y: 0, width: 100, height: 100 });
    rectOf(shown, { x: 300, y: 300, width: 50, height: 50 });
    const match = matchQuery({ testid: 'card' }, undefined, undefined, undefined, undefined, {
      overlaps: { testid: 'other' },
    });
    const overlap = match.elements[0]?.geometry?.overlap;
    expect(overlap?.intersects).toBe(false);
    expect(overlap?.box).toEqual({ x: 300, y: 300, width: 50, height: 50 });
  });

  it('excludes the measured element from the overlaps target', () => {
    // Review case on #1635: an overlaps query that also matches the measured element would
    // intersect the box with itself, so `intersects` could never be false. The measured
    // element is not a target; with nothing else matching, there is no overlap fact.
    document.body.innerHTML = '<div data-testid="card">Card</div>';
    rectOf(byTestid('card'), { x: 0, y: 0, width: 100, height: 100 });
    const match = matchQuery({ testid: 'card' }, undefined, undefined, undefined, undefined, {
      overlaps: { testid: 'card' },
    });
    expect(match.elements[0]?.geometry?.overlap).toBeUndefined();
  });

  it('measures overlap against the next match when the query names the measured element too', () => {
    document.body.innerHTML =
      '<div data-testid="card">Card</div><div data-testid="card">Card two</div>';
    const cards = Array.from(document.querySelectorAll('[data-testid="card"]'));
    const [first, second] = cards;
    if (2 !== cards.length || first === undefined || second === undefined) {
      throw new Error('no two cards');
    }
    rectOf(first, { x: 0, y: 0, width: 100, height: 100 });
    rectOf(second, { x: 300, y: 300, width: 50, height: 50 });
    const match = matchQuery({ testid: 'card' }, undefined, undefined, undefined, undefined, {
      overlaps: { testid: 'card' },
    });
    const overlap = match.elements[0]?.geometry?.overlap;
    expect(overlap?.intersects).toBe(false);
    expect(overlap?.box).toEqual({ x: 300, y: 300, width: 50, height: 50 });
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
