import { describe, it, expect, beforeEach } from 'vitest';
import { unmountedRowsIn } from './virtualized.js';

/** jsdom reports 0 for every layout box, so the geometry has to be stubbed explicitly. */
function box(el: HTMLElement, top: number, height: number): void {
  Object.defineProperty(el, 'offsetTop', { configurable: true, value: top });
  Object.defineProperty(el, 'offsetHeight', { configurable: true, value: height });
}
function scroller(el: HTMLElement, scrollHeight: number, clientHeight: number): void {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: scrollHeight });
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: clientHeight });
}

beforeEach(() => {
  document.body.innerHTML = '';
});

/**
 * A virtualizer reserves scroll space for the whole list and renders a window of it. Everything
 * outside that window is invisible to any DOM-based assertion — so "no row is held" over a 10,000-row
 * grid is a claim about the ~29 rows on screen, and reporting it as full coverage is a false green
 * with the same shape as every other one in this codebase.
 */
describe('rows a container reserved space for but never rendered', () => {
  it('counts the unmounted remainder of a spacer-and-absolute virtualizer', () => {
    // The standard shape: scroller > full-height spacer > absolutely positioned rows.
    document.body.innerHTML = '<div id="v"><div id="spacer"></div></div>';
    const view = document.querySelector<HTMLElement>('#v');
    const spacer = document.querySelector<HTMLElement>('#spacer');
    if (null === view || null === spacer) throw new Error('fixture');
    scroller(view, 1700, 560);
    box(spacer, 0, 1700);
    for (let i = 0; i < 29; i += 1) {
      const row = document.createElement('div');
      spacer.append(row);
      box(row, i * 34, 34);
    }
    // 1700 of scroll area, rows occupy 0..986 — the remaining 714px holds ~21 rows that do not exist.
    expect(unmountedRowsIn(view)).toBe(21);
  });

  it('reports ZERO for an ordinary long list, however large the gaps between rows', () => {
    // The false positive worth guarding: a gapped list has less CHILD HEIGHT than scroll height, but
    // its rows still span the whole area, so nothing is reserved-and-empty.
    document.body.innerHTML = '<div id="v"></div>';
    const view = document.querySelector<HTMLElement>('#v');
    if (null === view) throw new Error('fixture');
    scroller(view, 1000, 400);
    for (let i = 0; i < 20; i += 1) {
      const row = document.createElement('div');
      view.append(row);
      box(row, i * 50, 30); // 30px rows on a 50px pitch — 40% of the area is gap, not absence
    }
    expect(unmountedRowsIn(view)).toBe(0);
  });

  it('reports ZERO for a container that does not scroll', () => {
    document.body.innerHTML = '<div id="v"><div></div><div></div></div>';
    const view = document.querySelector<HTMLElement>('#v');
    if (null === view) throw new Error('fixture');
    scroller(view, 300, 300);
    expect(unmountedRowsIn(view)).toBe(0);
  });

  it('counts space reserved ABOVE the window too, after scrolling down', () => {
    document.body.innerHTML = '<div id="v"><div id="spacer"></div></div>';
    const view = document.querySelector<HTMLElement>('#v');
    const spacer = document.querySelector<HTMLElement>('#spacer');
    if (null === view || null === spacer) throw new Error('fixture');
    scroller(view, 3400, 560);
    box(spacer, 0, 3400);
    for (let i = 0; i < 20; i += 1) {
      const row = document.createElement('div');
      spacer.append(row);
      box(row, 1700 + i * 34, 34); // a window in the middle: rows above AND below are unmounted
    }
    expect(unmountedRowsIn(view)).toBeGreaterThan(70);
  });
});
