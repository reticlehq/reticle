/**
 * The chat panel's top carousel: the harness offer and the founder invitation, one at a time.
 *
 * It lives INSIDE the log's scroll container as its first child, so it takes no height from the panel
 * and new log rows push it up and out of view. Its slides share one fixed height, so switching never
 * shifts the log. One close control removes it for the tab session.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CAROUSEL_ATTR,
  CAROUSEL_CLOSE_ATTR,
  CAROUSEL_DISMISSED_KEY,
  CAROUSEL_DOT_ATTR,
  CAROUSEL_SLIDE_ATTR,
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
