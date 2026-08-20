import { describe, it, expect, beforeEach } from 'vitest';
import { ElementState } from '@reticlehq/core';
import { isInViewport } from './a11y.js';
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
});
