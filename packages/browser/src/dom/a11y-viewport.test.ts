import { afterEach, describe, expect, it } from 'vitest';
import { ElementState } from '@reticlehq/core';
import { getStates, isInViewport } from './a11y.js';
import { matchQuery } from './query.js';

/** A getBoundingClientRect stub returning a fixed viewport box. */
function rect(box: { left: number; top: number; width: number; height: number }): () => DOMRect {
  return (): DOMRect => ({
    x: box.left,
    y: box.top,
    left: box.left,
    top: box.top,
    right: box.left + box.width,
    bottom: box.top + box.height,
    width: box.width,
    height: box.height,
    toJSON: () => ({}),
  });
}

function clientBox(
  el: HTMLElement,
  box: { left: number; top: number; width: number; height: number },
): void {
  el.getBoundingClientRect = rect(box);
  Object.defineProperty(el, 'clientLeft', { configurable: true, value: 0 });
  Object.defineProperty(el, 'clientTop', { configurable: true, value: 0 });
  Object.defineProperty(el, 'clientWidth', { configurable: true, value: box.width });
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: box.height });
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('isInViewport', () => {
  it('is true when the element is fully inside the window viewport', () => {
    document.body.innerHTML = '<button data-testid="t">Go</button>';
    const btn = document.querySelector('button') as HTMLButtonElement;
    btn.getBoundingClientRect = rect({ left: 10, top: 20, width: 80, height: 30 });
    expect(isInViewport(btn)).toBe(true);
    expect(getStates(btn)).toContain(ElementState.IN_VIEWPORT);
  });

  it('is true when the element is only partially visible (edge overlap)', () => {
    document.body.innerHTML = '<button>Edge</button>';
    const btn = document.querySelector('button') as HTMLButtonElement;
    btn.getBoundingClientRect = rect({ left: -20, top: 0, width: 40, height: 30 });
    expect(isInViewport(btn)).toBe(true);
  });

  it('is false when the element is completely below the window viewport', () => {
    document.body.innerHTML = '<button>Below</button>';
    const btn = document.querySelector('button') as HTMLButtonElement;
    btn.getBoundingClientRect = rect({ left: 0, top: 5000, width: 100, height: 40 });
    expect(isInViewport(btn)).toBe(false);
    expect(getStates(btn)).not.toContain(ElementState.IN_VIEWPORT);
  });

  it('is false when the element is completely to the right of the viewport', () => {
    document.body.innerHTML = '<button>Right</button>';
    const btn = document.querySelector('button') as HTMLButtonElement;
    btn.getBoundingClientRect = rect({ left: 9000, top: 10, width: 100, height: 40 });
    expect(isInViewport(btn)).toBe(false);
  });

  it('is false for CSS-hidden elements even when geometry would intersect', () => {
    document.body.innerHTML = '<button style="display:none">Hidden</button>';
    const btn = document.querySelector('button') as HTMLButtonElement;
    btn.getBoundingClientRect = rect({ left: 0, top: 0, width: 100, height: 40 });
    expect(isInViewport(btn)).toBe(false);
  });

  it('is false for zero-area boxes', () => {
    document.body.innerHTML = '<button>Zero</button>';
    const btn = document.querySelector('button') as HTMLButtonElement;
    btn.getBoundingClientRect = rect({ left: 0, top: 0, width: 0, height: 0 });
    expect(isInViewport(btn)).toBe(false);
  });

  it('is false for disconnected elements', () => {
    const btn = document.createElement('button');
    btn.getBoundingClientRect = rect({ left: 0, top: 0, width: 100, height: 40 });
    expect(isInViewport(btn)).toBe(false);
  });

  it('is false when overflow:hidden clips the element', () => {
    const clip = document.createElement('div');
    clip.style.overflowY = 'hidden';
    clip.style.overflowX = 'hidden';
    clientBox(clip, { left: 0, top: 0, width: 200, height: 40 });
    const btn = document.createElement('button');
    btn.textContent = 'clip';
    clip.appendChild(btn);
    document.body.appendChild(clip);
    btn.getBoundingClientRect = rect({ left: 0, top: 50, width: 80, height: 24 });
    expect(isInViewport(btn)).toBe(false);
  });

  it('is false when scrolled out of an overflow scroll container', () => {
    const panel = document.createElement('div');
    panel.style.overflowY = 'scroll';
    Object.defineProperty(panel, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(panel, 'clientHeight', { configurable: true, value: 100 });
    clientBox(panel, { left: 0, top: 0, width: 100, height: 100 });
    const row = document.createElement('button');
    row.textContent = 'Row';
    row.setAttribute('data-testid', 'row');
    panel.appendChild(row);
    document.body.appendChild(panel);
    // Child is below the panel's visible client area (simulates scrolled-out row).
    row.getBoundingClientRect = rect({ left: 0, top: 200, width: 80, height: 24 });
    expect(isInViewport(row)).toBe(false);

    row.getBoundingClientRect = rect({ left: 0, top: 10, width: 80, height: 24 });
    expect(isInViewport(row)).toBe(true);
  });

  it('checks nested overflow scroll containers', () => {
    const outer = document.createElement('div');
    outer.style.overflowY = 'scroll';
    Object.defineProperty(outer, 'scrollHeight', { configurable: true, value: 500 });
    Object.defineProperty(outer, 'clientHeight', { configurable: true, value: 80 });
    clientBox(outer, { left: 0, top: 0, width: 220, height: 80 });

    const inner = document.createElement('div');
    inner.style.overflowY = 'scroll';
    Object.defineProperty(inner, 'scrollHeight', { configurable: true, value: 300 });
    Object.defineProperty(inner, 'clientHeight', { configurable: true, value: 60 });
    clientBox(inner, { left: 0, top: 0, width: 200, height: 60 });

    const btn = document.createElement('button');
    btn.setAttribute('data-testid', 'nested');
    inner.appendChild(btn);
    outer.appendChild(inner);
    document.body.appendChild(outer);

    btn.getBoundingClientRect = rect({ left: 0, top: 180, width: 80, height: 24 });
    expect(isInViewport(btn)).toBe(false);

    btn.getBoundingClientRect = rect({ left: 0, top: 10, width: 80, height: 24 });
    expect(isInViewport(btn)).toBe(true);
  });
});

describe('matchQuery with inViewport', () => {
  it('filters to elements in the viewport without changing visible counts', () => {
    document.body.innerHTML =
      '<button data-testid="row">on-screen</button>' +
      '<button data-testid="row">off-screen</button>';
    const [onScreen, offScreen] = document.querySelectorAll('button');
    (onScreen as HTMLButtonElement).getBoundingClientRect = rect({
      left: 0,
      top: 10,
      width: 100,
      height: 30,
    });
    (offScreen as HTMLButtonElement).getBoundingClientRect = rect({
      left: 0,
      top: 5000,
      width: 100,
      height: 30,
    });

    const visible = matchQuery({ by: 'testid', value: 'row' }, ElementState.VISIBLE);
    expect(visible.count).toBe(2);

    const inView = matchQuery({ by: 'testid', value: 'row' }, ElementState.IN_VIEWPORT);
    expect(inView.count).toBe(1);
    expect(inView.elements[0]?.name).toBe('on-screen');
  });
});
