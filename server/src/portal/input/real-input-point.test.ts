/**
 * The real pointer lands at `args.at`, a point inside the target as fractions of its box.
 *
 * A canvas has no child elements. The real pointer went to the centre of its box every time, so a
 * game drawn on a canvas, which reads the pointer position to know what was hit, could not be played.
 */
import { describe, expect, it } from 'vitest';
import { ActionType } from '@reticlehq/core';
import type { Page } from 'playwright';
import { performGesture } from './real-input.js';

/** Records each mouse call with its coordinates. */
function pointerPage(): { page: Page; calls: string[] } {
  const calls: string[] = [];
  const at =
    (name: string) =>
    (x: number, y: number): Promise<void> => {
      calls.push(`${name} ${String(x)},${String(y)}`);
      return Promise.resolve();
    };
  const page = {
    evaluate: () => Promise.resolve(),
    keyboard: { down: () => Promise.resolve(), up: () => Promise.resolve() },
    mouse: {
      move: at('move'),
      click: at('click'),
      dblclick: at('dblclick'),
      down: () => {
        calls.push('down');
        return Promise.resolve();
      },
      up: () => {
        calls.push('up');
        return Promise.resolve();
      },
    },
  } as unknown as Page;
  return { page, calls };
}

const CANVAS = { x: 100, y: 50, width: 200, height: 40 };
const noSleep = (): Promise<void> => Promise.resolve();

describe('performGesture at a point inside the target', () => {
  it('clicks and double clicks at the point, and reports it as the centre used', async () => {
    for (const action of [ActionType.CLICK, ActionType.DBLCLICK]) {
      const { page, calls } = pointerPage();
      const result = await performGesture(
        page,
        action,
        CANVAS,
        { at: { x: 0.25, y: 0.75 } },
        noSleep,
      );
      expect(calls).toEqual(['move 150,80', `${action} 150,80`]);
      expect(result.center).toEqual({ cx: 150, cy: 80 });
    }
  });

  it('hovers at the point', async () => {
    const { page, calls } = pointerPage();
    await performGesture(page, ActionType.HOVER, CANVAS, { at: { x: 0, y: 1 } }, noSleep);
    expect(calls).toEqual(['move 100,90', 'move 101,90', 'move 100,90']);
  });

  it('drags from `at` to `to` inside the drop target box', async () => {
    const { page, calls } = pointerPage();
    await performGesture(
      page,
      ActionType.DRAG,
      CANVAS,
      { at: { x: 0, y: 0 }, to: { x: 1, y: 1 }, toBox: CANVAS, steps: 2 },
      noSleep,
    );
    expect(calls).toEqual(['move 100,50', 'down', 'move 200,70', 'move 300,90', 'up']);
  });

  it('acts at the centre with no point, as before', async () => {
    const { page, calls } = pointerPage();
    await performGesture(page, ActionType.CLICK, CANVAS, {}, noSleep);
    expect(calls).toEqual(['move 200,70', 'click 200,70']);
  });
});
