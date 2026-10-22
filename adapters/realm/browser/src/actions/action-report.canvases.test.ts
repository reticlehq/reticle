import { afterEach, describe, expect, it } from 'vitest';
import { visibleCanvases } from './action-report.js';

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
