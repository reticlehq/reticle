/**
 * The chat panel's top carousel: the harness offer and the founder invitation, one at a time.
 *
 * It lives INSIDE the log's scroll container as its first child, so it takes no height from the panel
 * and new log rows push it up and out of view. Its slides share one fixed height, so switching never
 * shifts the log. One close control removes it for the tab session.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CAROUSEL_ATTR,
  CAROUSEL_CLOSE_ATTR,
  CAROUSEL_DISMISSED_KEY,
  CAROUSEL_DOT_ATTR,
  CAROUSEL_SLIDE_ATTR,
  ROTATE_MS,
  carouselHtml,
  paintCarousel,
} from './carousel.js';

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const values = new Map<string, string>();
  return {
    getItem: (k) => values.get(k) ?? null,
    setItem: (k, v) => {
      values.set(k, v);
    },
  };
}

const SLIDES = [
  { id: 'harness', html: '<p>Get Harness free for 3 months</p>' },
  { id: 'founders', html: '<p>Talk to Founders</p>' },
];

const visible = (root: ParentNode): string[] =>
  [...root.querySelectorAll(`[${CAROUSEL_SLIDE_ATTR}]`)]
    .filter((s) => !(s as HTMLElement).hidden)
    .map((s) => s.getAttribute(CAROUSEL_SLIDE_ATTR) ?? '');

describe('carouselHtml', () => {
  it('shows one slide, a dot per slide, and a close control', () => {
    const host = document.createElement('div');
    host.innerHTML = carouselHtml(SLIDES, 0);
    expect(visible(host)).toEqual(['harness']);
    expect(host.querySelectorAll(`[${CAROUSEL_DOT_ATTR}]`)).toHaveLength(2);
    expect(host.querySelector(`[${CAROUSEL_CLOSE_ATTR}]`)).not.toBeNull();
  });

  it('renders nothing when there is nothing to show', () => {
    expect(carouselHtml([], 0)).toBe('');
  });
});

describe('paintCarousel', () => {
  let log: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = '<div data-log><div data-reticle-log-row>older</div></div>';
    log = document.querySelector('[data-log]') as HTMLElement;
  });

  it('sits first in the log, above every row, and is replaced rather than duplicated', () => {
    const storage = memoryStorage();
    paintCarousel(log, SLIDES, storage);
    paintCarousel(log, SLIDES, storage);
    expect(log.firstElementChild?.hasAttribute(CAROUSEL_ATTR)).toBe(true);
    expect(log.querySelectorAll(`[${CAROUSEL_ATTR}]`)).toHaveLength(1);
  });

  it('switches slide from its dots, and keeps the slide it was on across a repaint', () => {
    const storage = memoryStorage();
    paintCarousel(log, SLIDES, storage);
    (log.querySelectorAll(`[${CAROUSEL_DOT_ATTR}]`)[1] as HTMLElement).click();
    expect(visible(log)).toEqual(['founders']);
    paintCarousel(log, SLIDES, storage);
    expect(visible(log)).toEqual(['founders']);
  });

  it('is removed by its close control for the rest of the tab session', () => {
    const storage = memoryStorage();
    paintCarousel(log, SLIDES, storage);
    (log.querySelector(`[${CAROUSEL_CLOSE_ATTR}]`) as HTMLElement).click();
    expect(log.querySelector(`[${CAROUSEL_ATTR}]`)).toBeNull();
    expect(storage.getItem(CAROUSEL_DISMISSED_KEY)).toBe('1');
    paintCarousel(log, SLIDES, storage);
    expect(log.querySelector(`[${CAROUSEL_ATTR}]`)).toBeNull();
    expect(log.textContent).toContain('older');
  });
});

/*
 * Auto-rotation: every ROTATE_MS, onward and round. It pauses while a pointer is over it or focus is
 * inside it (somebody reading, or tabbing to "Book a call", must not have the slide change under
 * them), and it does not run at all for somebody who asked for reduced motion.
 */
describe('auto-rotation', () => {
  let log: HTMLElement;
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div data-log></div>';
    log = document.querySelector('[data-log]') as HTMLElement;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('moves to the next slide on its own, and wraps round', () => {
    paintCarousel(log, SLIDES, memoryStorage());
    vi.advanceTimersByTime(ROTATE_MS);
    expect(visible(log)).toEqual(['founders']);
    vi.advanceTimersByTime(ROTATE_MS);
    expect(visible(log)).toEqual(['harness']);
  });

  it('holds still while hovered or focused, and carries on after', () => {
    paintCarousel(log, SLIDES, memoryStorage());
    const root = log.querySelector(`[${CAROUSEL_ATTR}]`) as HTMLElement;
    root.dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(ROTATE_MS * 3);
    expect(visible(log)).toEqual(['harness']);
    root.dispatchEvent(new MouseEvent('mouseleave'));
    root.dispatchEvent(new FocusEvent('focusin'));
    vi.advanceTimersByTime(ROTATE_MS * 3);
    expect(visible(log)).toEqual(['harness']);
    root.dispatchEvent(new FocusEvent('focusout'));
    vi.advanceTimersByTime(ROTATE_MS);
    expect(visible(log)).toEqual(['founders']);
  });

  it('keeps one timer across repaints, so a repaint never makes it skip', () => {
    const storage = memoryStorage();
    paintCarousel(log, SLIDES, storage);
    paintCarousel(log, SLIDES, storage);
    paintCarousel(log, SLIDES, storage);
    vi.advanceTimersByTime(ROTATE_MS);
    expect(visible(log)).toEqual(['founders']);
  });

  it('stops when closed, and does nothing with a single slide', () => {
    const storage = memoryStorage();
    paintCarousel(log, SLIDES, storage);
    (log.querySelector(`[${CAROUSEL_CLOSE_ATTR}]`) as HTMLElement).click();
    expect(vi.getTimerCount()).toBe(0);
    paintCarousel(log, [SLIDES[0] as (typeof SLIDES)[number]], memoryStorage());
    expect(vi.getTimerCount()).toBe(0);
  });

  // The panel can be torn down without anybody pressing close; the timer must not outlive it.
  it('stops its own timer once the carousel has left the page', () => {
    paintCarousel(log, SLIDES, memoryStorage());
    log.remove();
    vi.advanceTimersByTime(ROTATE_MS);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not rotate for somebody who asked for reduced motion', () => {
    const original = globalThis.matchMedia;
    globalThis.matchMedia = ((query: string) => ({ matches: query.includes('reduce') })) as never;
    try {
      paintCarousel(log, SLIDES, memoryStorage());
      vi.advanceTimersByTime(ROTATE_MS * 2);
      expect(visible(log)).toEqual(['harness']);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      globalThis.matchMedia = original;
    }
  });
});
