/**
 * What the peer takes for "on the screen": each element that has a place, whether it is inside its
 * window, and the dialog it is in. And the states of an element that the peer can read.
 */
import { ElementState } from '@reticlehq/core';

import { placeShown } from '../ui-node.js';
import type { Placed, UiNode } from '../ui-node.js';

function intersects(a: UiNode['frame'], b: UiNode['frame']): boolean {
  if (a === undefined || b === undefined) {
    return false;
  }
  return a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
}

export interface Seen extends Placed {
  /** The element has a size and is inside its window. It says nothing about a window on top. */
  visible: boolean;
  /** The name of the dialog the element is in, or an empty string. */
  dialog: string;
}

/** What is on the screen. An element with no place on it, as in a closed menu, is not here. */
export function see(root: UiNode): Seen[] {
  const placed = placeShown(root).shown;
  const byKey = new Map(placed.map((p) => [p.key, p]));
  return placed.map((p) => {
    let window: Placed | undefined = p;
    while (
      window !== undefined &&
      window.node.role !== 'window' &&
      window.parentKey !== undefined
    ) {
      window = byKey.get(window.parentKey);
    }
    let dialog: Placed | undefined = p;
    while (
      dialog !== undefined &&
      dialog.node.role !== 'dialog' &&
      dialog.parentKey !== undefined
    ) {
      dialog = byKey.get(dialog.parentKey);
    }
    const frame = p.node.frame;
    const sized = frame !== undefined && frame[2] > 0 && frame[3] > 0;
    const inside = 'window' === window?.node.role ? intersects(frame, window.node.frame) : sized;
    return {
      ...p,
      visible: sized && inside,
      dialog: 'dialog' === dialog?.node.role ? dialog.node.name : '',
    };
  });
}

export const READ_STATE: Readonly<Partial<Record<string, (seen: Seen) => boolean>>> = {
  [ElementState.PRESENT]: () => true,
  [ElementState.VISIBLE]: (s) => s.visible,
  [ElementState.HIDDEN]: (s) => !s.visible,
  [ElementState.ENABLED]: (s) => !s.node.states.includes(ElementState.DISABLED),
  [ElementState.DISABLED]: (s) => s.node.states.includes(ElementState.DISABLED),
  [ElementState.CHECKED]: (s) => s.node.states.includes(ElementState.CHECKED),
  [ElementState.FOCUSED]: (s) => s.node.states.includes(ElementState.FOCUSED),
};
