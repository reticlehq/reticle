/**
 * A pointer action lands at `args.at`, a point inside the target as fractions of its box.
 *
 * A canvas has no child elements. Every pointer action landed at the centre of its box, so a game
 * drawn on a canvas, which reads `clientX`/`clientY` to know what was hit, could not be played.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { ActionType } from '@reticlehq/core';
import { refs } from '@/dom/addressing/refs.js';
import { executeAction } from './actions.js';

/** Place an element at a known box: jsdom reports zeros otherwise. */
function boxed(el: HTMLElement, x: number, y: number, w: number, h: number): HTMLElement {
  el.getBoundingClientRect = () =>
    ({ x, y, left: x, top: y, right: x + w, bottom: y + h, width: w, height: h }) as DOMRect;
  return el;
}

const POINTER_TYPES = [
  'pointerdown',
  'pointermove',
  'pointerup',
  'pointerover',
  'pointerenter',
  'mousedown',
  'mousemove',
  'mouseup',
  'mouseover',
  'mouseenter',
  'click',
  'dblclick',
];

let canvas: HTMLElement;
let seen: { type: string; x: number; y: number }[];

beforeEach(() => {
  document.body.innerHTML = '';
  canvas = boxed(document.createElement('canvas'), 100, 50, 200, 40);
  document.body.append(canvas);
  seen = [];
  for (const type of POINTER_TYPES) {
    canvas.addEventListener(type, (event) => {
      const e = event as MouseEvent;
      seen.push({ type: e.type, x: e.clientX, y: e.clientY });
    });
  }
});

const at = { x: 0.25, y: 0.75 };
/** The point `at` names on the canvas box: 100 + 200 * 0.25, 50 + 40 * 0.75. */
const POINT = { x: 150, y: 80 };

describe('a pointer action at a point inside the target', () => {
  it.each([ActionType.CLICK, ActionType.DBLCLICK, ActionType.HOVER, ActionType.TAP])(
    '%s dispatches every pointer and mouse event at the point',
    async (action) => {
      await executeAction(refs.refFor(canvas), action, { at });
      const pointed = seen.filter((e) => !e.type.startsWith('touch'));
      expect(pointed.length).toBeGreaterThan(0);
      for (const e of pointed) {
        expect({ type: e.type, x: e.x, y: e.y }).toEqual({ type: e.type, ...POINT });
      }
    },
  );

  it('drags inside one element, from `at` to `to`', async () => {
    await executeAction(refs.refFor(canvas), ActionType.DRAG, { at, to: { x: 1, y: 0 } });
    const down = seen.find((e) => 'pointerdown' === e.type);
    const up = seen.find((e) => 'pointerup' === e.type);
    expect(down).toMatchObject(POINT);
    expect(up).toMatchObject({ x: 300, y: 50 });
  });

  it('clamps a point outside the box to its edge', async () => {
    await executeAction(refs.refFor(canvas), ActionType.CLICK, { at: { x: 2, y: -1 } });
    expect(seen.find((e) => 'click' === e.type)).toMatchObject({ x: 300, y: 50 });
  });

  it('refuses a point that is not two numbers, and does not act at the centre', async () => {
    await expect(
      executeAction(refs.refFor(canvas), ActionType.CLICK, { at: { x: 'left', y: 0 } }),
    ).rejects.toThrow('`at`');
    expect(seen).toEqual([]);
  });

  it('acts at the centre with no point, as before', async () => {
    await executeAction(refs.refFor(canvas), ActionType.CLICK, {});
    expect(seen.find((e) => 'click' === e.type)).toMatchObject({ x: 200, y: 70 });
  });
});
