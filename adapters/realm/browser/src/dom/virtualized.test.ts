import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { unmountedRowsIn } from './virtualized.js';

/** jsdom reports 0 for every layout box, so the geometry has to be stubbed explicitly. */
function box(el: HTMLElement, top: number, height: number): void {
  Object.defineProperty(el, 'offsetTop', { configurable: true, value: top });
  Object.defineProperty(el, 'offsetHeight', { configurable: true, value: height });
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, top, 100, height));
}
function scroller(el: HTMLElement, scrollHeight: number, clientHeight: number): void {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: scrollHeight });
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: clientHeight });
}

beforeEach(() => {
  document.body.innerHTML = '';
});
afterEach(() => vi.restoreAllMocks());

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

  it("does not count a normal panel's page offset as unmounted space after deletion", () => {
    const view = document.createElement('div');
    document.body.append(view);
    scroller(view, 1000, 400);
    box(view, 600, 400); // unpositioned rows have an offsetParent outside this scroller
    for (let i = 0; i < 20; i += 1) {
      const row = document.createElement('div');
      view.append(row);
      box(row, 600 + i * 50, 50);
    }
    const deleted = document.createElement('section');
    document.body.append(deleted);
    deleted.remove();
    expect(unmountedRowsIn(view)).toBe(0);
  });

  it('normalizes the scroller border and scroll position when measuring reserved rows', () => {
    const view = document.createElement('div');
    document.body.append(view);
    scroller(view, 1000, 400);
    box(view, 600, 410);
    Object.defineProperty(view, 'clientTop', { value: 5 });
    view.scrollTop = 200;
    for (let i = 0; i < 5; i += 1) {
      const row = document.createElement('div');
      view.append(row);
      // Rendered window occupies scroll coordinates 200..400, and viewport coordinates 605..805.
      box(row, i * 40, 40); // offsetTop is relative to a different positioning context
      vi.spyOn(row, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 605 + i * 40, 100, 40));
    }
    expect(unmountedRowsIn(view)).toBe(20);
  });

  it.each([
    { scale: 1.5, rendered: 15, unmounted: 10 },
    { scale: 0.5, rendered: 25, unmounted: 0 },
  ])('keeps layout counts under scale $scale', ({ scale, rendered, unmounted }) => {
    const view = document.createElement('div');
    document.body.append(view);
    scroller(view, 1000, 200);
    box(view, 400, 200);
    vi.spyOn(view, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 400, 320, 200 * scale));
    for (let i = 0; i < rendered; i += 1) {
      const row = document.createElement('div');
      view.append(row);
      box(row, i * 40, 40);
      vi.spyOn(row, 'getBoundingClientRect').mockReturnValue(
        new DOMRect(0, 400 + i * 40 * scale, 320, 40 * scale),
      );
    }
    expect(unmountedRowsIn(view)).toBe(unmounted);
  });

  it('normalizes scaled borders and scroll offsets in a virtualized window', () => {
    const view = document.createElement('div');
    document.body.append(view);
    scroller(view, 1000, 200);
    box(view, 600, 210);
    Object.defineProperty(view, 'clientTop', { value: 5 });
    view.scrollTop = 200;
    vi.spyOn(view, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 600, 480, 315));
    for (let i = 0; i < 15; i += 1) {
      const row = document.createElement('div');
      view.append(row);
      box(row, 200 + i * 40, 40);
      vi.spyOn(row, 'getBoundingClientRect').mockReturnValue(
        new DOMRect(0, 600 + (5 + i * 40) * 1.5, 480, 60),
      );
    }
    expect(unmountedRowsIn(view)).toBe(10);
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
