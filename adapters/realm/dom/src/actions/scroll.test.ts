import { afterEach, describe, expect, it } from 'vitest';
import { refs } from '../dom/refs.js';
import { scrollContainer } from './scroll.js';

/** Make a real div behave like a scrollable container (jsdom has no layout, so we define metrics). */
function scrollableDiv(scrollHeight: number, clientHeight: number): HTMLDivElement {
  const div = document.createElement('div');
  div.style.overflowY = 'scroll'; // getComputedStyle reads inline style in jsdom
  Object.defineProperty(div, 'scrollHeight', { configurable: true, value: scrollHeight });
  Object.defineProperty(div, 'clientHeight', { configurable: true, value: clientHeight });
  let top = 0;
  Object.defineProperty(div, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      top = Math.max(0, Math.min(v, scrollHeight - clientHeight));
    },
  });
  document.body.appendChild(div);
  return div;
}

describe('scrollContainer', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('1: scrolls the ref container ~a viewport and reports position (not yet at end)', () => {
    const div = scrollableDiv(1000, 200);
    const r = scrollContainer(refs.refFor(div), undefined);
    expect(r.scrolled).toBe(true);
    expect(r.scrollTop).toBe(160); // 200 * 0.8 default step
    expect(r.atEnd).toBe(false);
    expect(r.scrollHeight).toBe(1000);
  });

  it('2: an explicit dy is honored', () => {
    const div = scrollableDiv(1000, 200);
    const r = scrollContainer(refs.refFor(div), 500);
    expect(r.scrollTop).toBe(500);
  });

  it('3: scrolling near the bottom clamps and reports atEnd', () => {
    const div = scrollableDiv(1000, 200);
    const ref = refs.refFor(div);
    scrollContainer(ref, 700); // → 700
    const r = scrollContainer(ref, 700); // clamps to 800 (1000-200), at end
    expect(r.scrollTop).toBe(800);
    expect(r.atEnd).toBe(true);
  });

  it('4: a non-scrollable ref falls back to the document and returns the result shape', () => {
    const div = document.createElement('div');
    document.body.appendChild(div);
    const r = scrollContainer(refs.refFor(div), 100);
    expect(typeof r.scrollTop).toBe('number');
    expect(typeof r.atEnd).toBe('boolean');
    expect(typeof r.scrolled).toBe('boolean');
  });
});
