/**
 * A drag has to carry coordinates, or it is a false green in our own tooling.
 *
 * Reported by an agent driving a `@dnd-kit/core` board: `reticle_act { action: "drag" }` returned
 * `ok:true`, `dispatched:true`, `effect.domMutatedWithin:0` — and the card had not moved. dnd-kit
 * resolves the `over` droppable from collision GEOMETRY, and every pointer event we dispatched was
 * built as `new PointerEvent(type, { bubbles, cancelable })`, so both source and target reported
 * `(0,0)`. Zero delta, so `onDragEnd` sees `over === source`, and the app is unchanged while the
 * tool reports success. That is the one failure mode this product exists to catch, produced by the
 * product.
 *
 * Three properties are needed and all three were missing:
 *
 *  - **coordinates**, so a geometry-based library can tell source from target at all;
 *  - **`buttons: 1` on the moves**, because the standard "was the mouse released?" guard is
 *    `event.buttons === 0` — a second reporter's drag-select bailed on exactly that;
 *  - **intermediate moves**, because `activationConstraint: { distance: N }` is the standard config
 *    for keeping a draggable card clickable, and one jump from A to B never crosses the threshold
 *    in a way the sensor observes.
 *
 * Also here: `press` set `key` and never `code`. dnd-kit's KeyboardSensor, react-aria and anything
 * keyed on physical keys match on `code`, so the keyboard fallback was unavailable too.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { dragElement } from './actions-dom.js';
import { at } from '../test-support/array-at.js';

interface Captured {
  type: string;
  clientX: number;
  clientY: number;
  buttons: number;
}

/** Place an element at a known box — jsdom reports zeros otherwise, which is the bug's disguise. */
function boxed(el: HTMLElement, x: number, y: number, w = 100, h = 40): HTMLElement {
  el.getBoundingClientRect = () =>
    ({ x, y, left: x, top: y, right: x + w, bottom: y + h, width: w, height: h }) as DOMRect;
  return el;
}

let source: HTMLElement;
let target: HTMLElement;
let seen: Captured[];

beforeEach(() => {
  document.body.innerHTML = '';
  source = boxed(document.createElement('div'), 0, 0);
  target = boxed(document.createElement('div'), 400, 200);
  document.body.append(source, target);
  seen = [];
  for (const type of [
    'pointerdown',
    'pointermove',
    'pointerup',
    'mousedown',
    'mousemove',
    'mouseup',
  ]) {
    document.addEventListener(type, (event) => {
      const e = event as PointerEvent;
      seen.push({ type: e.type, clientX: e.clientX, clientY: e.clientY, buttons: e.buttons });
    });
  }
});

const of = (type: string): Captured[] => seen.filter((e) => e.type === type);

describe('drag carries geometry', () => {
  it('starts at the source centre, not (0,0)', async () => {
    await dragElement(source, target, undefined);
    const down = of('pointerdown')[0];
    expect(down?.clientX).toBe(50);
    expect(down?.clientY).toBe(20);
  });

  it('ends at the target centre, so `over` can resolve to something else', async () => {
    await dragElement(source, target, undefined);
    const up = of('pointerup')[0];
    expect(up?.clientX).toBe(450);
    expect(up?.clientY).toBe(220);
  });

  it('emits intermediate moves, so a distance activationConstraint is satisfied', async () => {
    await dragElement(source, target, undefined);
    expect(of('pointermove').length).toBeGreaterThan(1);
  });

  it('advances monotonically from source to target', async () => {
    await dragElement(source, target, undefined);
    const xs = of('pointermove').map((e) => e.clientX);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    expect(at(xs, -1)).toBe(450);
  });

  it('holds the primary button down through every move', async () => {
    await dragElement(source, target, undefined);
    // `event.buttons === 0` is the standard "mouse was released" guard; a move that reports 0 makes
    // a correct handler bail out mid-drag, which is indistinguishable from a broken fix.
    expect(of('pointermove').every((e) => 1 === e.buttons)).toBe(true);
    expect(of('mousemove').every((e) => 1 === e.buttons)).toBe(true);
  });

  it('releases the button on pointerup', async () => {
    await dragElement(source, target, undefined);
    expect(of('pointerup')[0]?.buttons).toBe(0);
  });

  it('a free drag with no target still moves within the source', async () => {
    await dragElement(source, null, undefined);
    expect(of('pointerdown')[0]?.clientX).toBe(50);
    expect(of('pointerup')[0]?.clientX).toBe(50);
  });
});
