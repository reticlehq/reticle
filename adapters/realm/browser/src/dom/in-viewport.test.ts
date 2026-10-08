import { describe, it, expect, beforeEach } from 'vitest';
import { ElementState } from '@reticlehq/core';
import { isInViewport, isVisible } from './a11y.js';
import { matchQuery } from './query.js';

/**
 * #398: `visible`/`present` fold only aria-hidden/[hidden]/display/visibility/opacity, so content
 * below the fold of a scrolling container is already `visible` and a scrollIntoView is ungradeable
 * (act_and_wait returns already_true). An `inViewport` state, backed by getBoundingClientRect, makes
 * the scroll assertable. jsdom does no layout, so the box is stubbed per element (window is 1024x768).
 */
function boxed(rect: Partial<DOMRect>, tag = 'div'): HTMLElement {
  const el = document.createElement(tag);
  document.body.appendChild(el);
  el.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
    toJSON: () => ({}),
    ...rect,
  });
  return el;
}

describe('isInViewport (#398)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('true when the box intersects the window', () => {
    expect(
      isInViewport(
        boxed({ top: 100, left: 100, bottom: 220, right: 260, width: 160, height: 120 }),
      ),
    ).toBe(true);
  });

  it('false when the box is below the fold (top past innerHeight)', () => {
    expect(
      isInViewport(
        boxed({ top: 2000, left: 100, bottom: 2120, right: 260, width: 160, height: 120 }),
      ),
    ).toBe(false);
  });

  it('false when the element is hidden, whatever the box says', () => {
    const el = boxed({ top: 100, left: 100, bottom: 220, right: 260, width: 160, height: 120 });
    el.style.display = 'none';
    expect(isInViewport(el)).toBe(false);
  });

  it('false for a zero-size box', () => {
    expect(
      isInViewport(boxed({ top: 100, left: 100, bottom: 100, right: 100, width: 0, height: 0 })),
    ).toBe(false);
  });

  it('keeps an off-window box visible when no ancestor clips it', () => {
    const el = boxed({ top: 2000, left: 100, bottom: 2120, right: 260, width: 160, height: 120 });
    expect(isVisible(el)).toBe(true);
    expect(isInViewport(el)).toBe(false);
  });

  it.each(['auto', 'scroll'])(
    'keeps overflow:%s viewport checks relative to the window',
    (overflow) => {
      const scrollport = boxed({
        top: 0,
        left: 0,
        bottom: 100,
        right: 100,
        width: 100,
        height: 100,
      });
      scrollport.style.overflow = overflow;
      scrollport.style.overflowX = overflow;
      scrollport.style.overflowY = overflow;
      const el = boxed({ top: 120, left: 10, bottom: 140, right: 90, width: 80, height: 20 });
      scrollport.append(el);
      expect(isVisible(el)).toBe(true);
      expect(isInViewport(el)).toBe(true);
      el.getBoundingClientRect = () => new DOMRect(10, 2000, 80, 20);
      expect(isVisible(el)).toBe(true);
      expect(isInViewport(el)).toBe(false);
    },
  );

  it('excludes fully clipped boxes inside the window while retaining partial overlaps', () => {
    const clip = boxed({ top: 0, left: 0, bottom: 100, right: 100, width: 100, height: 100 });
    clip.style.overflow = 'hidden';
    clip.style.overflowX = 'hidden';
    clip.style.overflowY = 'hidden';
    const el = boxed({ top: 120, left: 10, bottom: 140, right: 90, width: 80, height: 20 });
    el.dataset.testid = 'clipped';
    clip.append(el);
    expect(isInViewport(el)).toBe(false);
    expect(matchQuery({ testid: 'clipped' }, ElementState.IN_VIEWPORT).count).toBe(0);
    el.getBoundingClientRect = () => new DOMRect(10, 90, 80, 20);
    expect(isInViewport(el)).toBe(true);
    expect(matchQuery({ testid: 'clipped' }, ElementState.IN_VIEWPORT).count).toBe(1);
  });

  it('requires the portion surviving ancestor clipping to intersect the viewport', () => {
    const clip = boxed({ top: 10, left: -100, bottom: 30, right: -50, width: 50, height: 20 });
    clip.style.overflow = 'hidden';
    clip.style.overflowX = 'hidden';
    clip.style.overflowY = 'hidden';
    const el = boxed({ top: 10, left: -100, bottom: 30, right: 100, width: 200, height: 20 });
    clip.append(el);
    expect(isVisible(el)).toBe(true);
    expect(isInViewport(el)).toBe(false);
  });

  it('the element predicate filters by inViewport end to end', () => {
    // Two buttons named "Go"; only the first is scrolled into view.
    const onScreen = boxed(
      { top: 100, left: 100, bottom: 140, right: 200, width: 100, height: 40 },
      'button',
    );
    onScreen.textContent = 'Go';
    const belowFold = boxed(
      { top: 3000, left: 100, bottom: 3040, right: 200, width: 100, height: 40 },
      'button',
    );
    belowFold.textContent = 'Go';

    const all = matchQuery({ role: 'button', name: 'Go' });
    expect(all.count).toBe(2);
    const inView = matchQuery({ role: 'button', name: 'Go' }, ElementState.IN_VIEWPORT);
    expect(inView.count).toBe(1);
  });

  it('stamps inViewport on a single match when the predicate asks for that state (#1279)', () => {
    const btn = boxed(
      { top: 100, left: 100, bottom: 140, right: 200, width: 100, height: 40 },
      'button',
    );
    btn.textContent = 'Submit';

    const result = matchQuery({ role: 'button', name: 'Submit' }, ElementState.IN_VIEWPORT);
    expect(result.count).toBe(1);
    expect(result.elements[0]?.states).toContain(ElementState.IN_VIEWPORT);
  });

  it('stamps inViewport onto multi-match descriptors so ambiguity can be ranked (#886)', () => {
    const onScreen = boxed(
      { top: 100, left: 100, bottom: 140, right: 200, width: 100, height: 40 },
      'button',
    );
    onScreen.textContent = 'Go';
    const belowFold = boxed(
      { top: 3000, left: 100, bottom: 3040, right: 200, width: 100, height: 40 },
      'button',
    );
    belowFold.textContent = 'Go';

    const all = matchQuery({ role: 'button', name: 'Go' });
    expect(all.elements).toHaveLength(2);
    const stamped = all.elements.filter((e) => e.states.includes(ElementState.IN_VIEWPORT));
    expect(stamped).toHaveLength(1);
  });
});
