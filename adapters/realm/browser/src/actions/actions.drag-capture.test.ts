/**
 * A control that captures the pointer on pointerdown hears the rest of the drag on itself.
 *
 * A slider calls `setPointerCapture` and then moves from `pointermove` on the same element. The
 * drag sent those moves to the drop target, so the control reported a completed drag and never
 * moved.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { dragElement } from './actions-dom.js';

function required(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (!(found instanceof HTMLElement)) throw new Error(`missing #${id}`);
  return found;
}

describe('a drag follows pointer capture', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="handle"></div><div id="lane"></div>';
  });

  it('sends pointer moves to the element that captured the pointer', async () => {
    const handle = required('handle');
    const lane = required('lane');
    const moves: string[] = [];
    handle.addEventListener('pointerdown', (event) => {
      if (!(event instanceof PointerEvent)) return;
      handle.setPointerCapture(event.pointerId);
    });
    handle.addEventListener('pointermove', () => {
      moves.push('handle');
    });
    lane.addEventListener('pointermove', () => {
      moves.push('lane');
    });

    await dragElement(handle, lane, undefined);

    expect(moves).toContain('handle');
    expect(moves).not.toContain('lane');
  });
});
