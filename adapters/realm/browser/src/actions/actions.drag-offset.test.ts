/**
 * A swipe or a slider moves by a distance. `drag` used to read only a drop target, so
 * `{ deltaX: -120 }` was ignored and the pointer went nowhere while the call reported success.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { ActionType } from '@reticlehq/core';
import { executeAction } from './actions.js';
import { refs } from '@/dom/addressing/refs.js';

describe('drag by a pixel offset', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  const source = (): HTMLElement => {
    document.body.innerHTML = '<div id="a">A</div>';
    const el = document.getElementById('a');
    if (null === el) throw new Error('missing source');
    return el;
  };

  it('moves along a path that ends at the offset', async () => {
    const el = source();
    const moves: number[] = [];
    let up = 0;
    el.addEventListener('pointermove', (event) => {
      moves.push(event.clientX);
    });
    el.addEventListener('pointerup', (event) => {
      up = event.clientX;
    });

    await executeAction(refs.refFor(el), ActionType.DRAG, { by: { x: -120, y: 40 } });

    expect(moves.length).toBeGreaterThan(1);
    expect(moves.at(-1)).toBe(-120);
    expect(up).toBe(-120);
  });

  it('refuses an argument it does not read, before any pointer event', async () => {
    const el = source();
    let seen = 0;
    el.addEventListener('pointerdown', () => {
      seen += 1;
    });

    await expect(executeAction(refs.refFor(el), ActionType.DRAG, { deltaX: -120 })).rejects.toThrow(
      /deltaX/,
    );
    expect(seen).toBe(0);
  });
});
