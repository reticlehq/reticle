/**
 * Matrix drive (bench-app `login-collapsed`): a submit button collapsed to 0×0 with its overflow
 * clipped read `visible: true` in `reticle_look element`, and a visible-state check on it held. A
 * person sees nothing there. jsdom does no layout, so the boxes are stubbed per element.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { isVisible } from './visibility.js';

const zeroBox = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };

function button(style: string): HTMLElement {
  const el = document.createElement('button');
  el.textContent = 'Sign in';
  el.setAttribute('style', `display:inline-block;${style}`); // a browser's button; jsdom's is inline
  document.body.appendChild(el);
  const rect = { ...zeroBox, toJSON: () => ({}) } as DOMRect;
  el.getBoundingClientRect = () => rect;
  el.getClientRects = () => [rect] as unknown as DOMRectList;
  return el;
}

beforeEach(() => {
  document.body.replaceChildren();
});

describe('a control collapsed to nothing', () => {
  it('is not visible when its box is 0×0 and it clips its own overflow', () => {
    expect(isVisible(button('width:0;height:0;overflow-x:hidden;overflow-y:hidden'))).toBe(false);
  });

  it('stays visible when nothing clips it, since its content can still show', () => {
    expect(isVisible(button('width:0;height:0'))).toBe(true);
  });

  it('stays visible with no layout box at all (display: contents, an unlaid page)', () => {
    const el = button('overflow-x:hidden;overflow-y:hidden');
    el.getClientRects = () => [] as unknown as DOMRectList;
    expect(isVisible(el)).toBe(true);
  });
});
