import { afterEach, describe, expect, it } from 'vitest';
import { visibleCanvases } from './action-report.js';
import { isInViewport } from '@/dom/visibility.js';

/** Give a canvas a layout box, which the test DOM does not compute. */
function place(canvas: HTMLCanvasElement, top: number, size: number): void {
  canvas.getBoundingClientRect = () =>
    ({ top, left: 0, bottom: top + size, right: size, width: size, height: size }) as DOMRect;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('visibleCanvases', () => {
  it('counts a sized canvas inside the viewport', () => {
    const canvas = document.createElement('canvas');
    place(canvas, 10, 100);
    document.body.append(canvas);
    expect(visibleCanvases(document)).toBe(1);
  });

  it('skips a canvas with no size, and one below the viewport', () => {
    const empty = document.createElement('canvas');
    place(empty, 10, 0);
    const below = document.createElement('canvas');
    place(below, window.innerHeight + 50, 100);
    document.body.append(empty, below);
    expect(visibleCanvases(document)).toBe(0);
  });
});

/**
 * The canvas observer marks each digest with this, so a canvas that is hidden or off screen cannot
 * stand in for a render nobody sees (#1525).
 */
describe('isInViewport on a canvas', () => {
  it('is true for a shown canvas inside the viewport, false for hidden or off screen', () => {
    const shown = document.createElement('canvas');
    place(shown, 10, 64);
    // `display: none` lays out no box, which is what a browser reports for it.
    const hidden = document.createElement('canvas');
    hidden.style.display = 'none';
    place(hidden, 0, 0);
    const offScreen = document.createElement('canvas');
    place(offScreen, -500, 64);
    // `visibility: hidden` keeps its box, so the box alone would read it as on screen.
    const invisible = document.createElement('canvas');
    invisible.style.visibility = 'hidden';
    place(invisible, 10, 64);
    document.body.append(shown, hidden, offScreen, invisible);
    expect([shown, hidden, offScreen, invisible].map((canvas) => isInViewport(canvas))).toEqual([
      true,
      false,
      false,
      false,
    ]);
  });
});
