// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest';
import { paintContextOf } from './paint-context.js';

/**
 * What an ancestor does to this element's pixels, which its own computed style cannot say.
 *
 * This is the regression Reticle measurably lost to a screenshot. A `filter: hue-rotate(90deg)` on
 * an ANCESTOR changed 21,393 pixels; `getComputedStyle(el)` was byte-identical before and after,
 * and correctly so — the filter is not the element's property. The read was not wrong, it was at
 * the wrong layer: CSS rasterisation composes down the ancestor chain, and a flat per-element style
 * describes one link of it.
 *
 * Proved in a real browser before this was written. Same element, before and after:
 *
 *   ownComputed           padding 16px, background rgb(255,255,255), filter "none"   — IDENTICAL
 *   ancestorPaintContext  []  ->  [{ el: "wrap", prop: "filter", value: "hue-rotate(90deg)" }]
 *
 * So the truth was readable from inside the whole time. A screenshot is the lazy way to collapse
 * that composition: it collapses it into pixels and discards every term, which is why it can say
 * 21,393 pixels differ and never which element, which property or which line.
 *
 * Only properties that change RASTERISATION without changing the element's own computed style go in
 * here. A default (`none`, `1`, `normal`) is not a paint context and is omitted, so a clean chain
 * costs nothing.
 */
const el = (html: string): HTMLElement => {
  document.body.innerHTML = html;
  const found = document.getElementById('target');
  if (null === found) throw new Error('fixture has no #target');
  return found;
};

describe('paintContextOf', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('is empty for an element nobody is painting over', () => {
    expect(paintContextOf(el('<div><div id="target">hi</div></div>'))).toEqual([]);
  });

  it('reports an ANCESTOR filter — the case that lost to a screenshot', () => {
    const ctx = paintContextOf(
      el('<div id="wrap" style="filter: hue-rotate(90deg)"><div id="target">hi</div></div>'),
    );
    expect(ctx).toHaveLength(1);
    expect(ctx[0]?.property).toBe('filter');
    expect(ctx[0]?.value).toContain('hue-rotate');
    expect(ctx[0], 'the reader must be told WHICH ancestor, or it cannot act').toHaveProperty('on');
  });

  it('reports the element’s OWN paint property too', () => {
    // An element can tint itself; the question is "what is painting this", not "what is above it".
    const ctx = paintContextOf(el('<div><div id="target" style="opacity: 0.5">hi</div></div>'));
    expect(ctx.some((c) => 'opacity' === c.property)).toBe(true);
  });

  it('reports several, nearest first, so the closest cause reads first', () => {
    const ctx = paintContextOf(
      el(
        '<div id="outer" style="opacity: 0.5"><div id="inner" style="filter: blur(2px)"><div id="target">hi</div></div></div>',
      ),
    );
    expect(ctx.map((c) => c.property)).toEqual(['filter', 'opacity']);
  });

  it('omits defaults, so a clean chain costs nothing', () => {
    const ctx = paintContextOf(
      el('<div style="filter: none; opacity: 1"><div id="target">hi</div></div>'),
    );
    expect(ctx).toEqual([]);
  });

  it('stops at the document, never walking out of it', () => {
    expect(() => paintContextOf(el('<div id="target">hi</div>'))).not.toThrow();
  });
});
