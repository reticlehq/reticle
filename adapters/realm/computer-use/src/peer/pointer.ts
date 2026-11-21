/**
 * The real pointer: which action of a tool is which gesture, what to say when a gesture needs
 * the foreground, and where on the screen a point of a picture of the window is.
 */
import { ActionType } from '@reticlehq/core';

import { ActKind } from '../driver.js';
import { placeShown } from '../ui-node.js';
import type { UiNode } from '../ui-node.js';
import { KIND_OF } from './form.js';

/** Where a picture of the window was taken, and its pixels for each point of the screen. */
export interface Picture {
  window: readonly [number, number, number, number];
  scale: number;
  /** Where each element on the screen was when the picture was taken, by its key. */
  places?: ReadonlyMap<string, readonly number[]>;
}

/** The place of each element on the screen, by its key. */
export function placesOf(root: UiNode): Map<string, readonly number[]> {
  const out = new Map<string, readonly number[]>();
  for (const p of placeShown(root).shown) {
    if (p.node.frame !== undefined) {
      out.set(p.key, p.node.frame);
    }
  }
  return out;
}

/**
 * True when the content of the window moved after the picture: an element that has the same
 * size is at another place, as the rows of a list that scrolled. A value that changes in its
 * place, as a clock, does not move the content.
 */
export function contentMoved(
  then: ReadonlyMap<string, readonly number[]> | undefined,
  now: ReadonlyMap<string, readonly number[]>,
): boolean {
  for (const [key, was] of then ?? []) {
    const is = now.get(key);
    const sameSize = is !== undefined && is[2] === was[2] && is[3] === was[3];
    if (sameSize && (is[0] !== was[0] || is[1] !== was[1])) {
      return true;
    }
  }
  return false;
}

/**
 * The point on the screen for `args.at`, which is a point of the last picture, in its pixels.
 * Only the kinds that use the real pointer take a point. Absent answer: no point was given.
 */
export function pointOnScreen(
  picture: Picture | undefined,
  at: unknown,
  kind: ActKind,
): string | undefined {
  const point: Record<string, unknown> =
    'object' === typeof at && null !== at ? (at as Record<string, unknown>) : {};
  const { x, y } = point;
  if ('number' !== typeof x || 'number' !== typeof y) {
    return undefined;
  }
  if (!POINT_KINDS.has(kind)) {
    throw new Error(
      'args.at is a point for the real pointer. Send it with args: { foreground: true } on click, dblclick or hover.',
    );
  }
  if (picture === undefined) {
    throw new Error(
      'args.at is a point of a picture of the window, and no picture was taken. Take one first: reticle_screenshot.',
    );
  }
  const { window, scale } = picture;
  return `${String(window[0] + x / scale)},${String(window[1] + y / scale)}`;
}

/** What the helper says when the terminal may not record the screen. */
export const NO_SCREEN_RECORDING = 'no-screen-recording-permission';
/** The kinds that can go to a point of a picture, and not to the middle of an element. */
const POINT_KINDS: ReadonlySet<string> = new Set([
  ActKind.CLICK,
  ActKind.DBLCLICK,
  ActKind.RIGHTCLICK,
  ActKind.HOVER,
]);
/** The mouse button a click asks for. Only the right one changes anything. */
const RIGHT_BUTTON = 'right';

/**
 * The kind of action of the realm for an action of a tool. A click with the right button is the
 * menu a right-click gives: asked for by name in the background, and the real button in the
 * foreground. A click in the foreground is the real pointer.
 */
export function kindFor(
  action: string,
  more: Record<string, unknown>,
  foreground: boolean,
): ActKind | undefined {
  if (action === ActionType.CLICK && RIGHT_BUTTON === more['button']) {
    return foreground ? ActKind.RIGHTCLICK : ActKind.MENU;
  }
  if (action === ActionType.CLICK && foreground) {
    return ActKind.CLICK;
  }
  return KIND_OF[action];
}

/** What to say when an action needs the real pointer and the caller did not ask for it. */
export function needsForeground(action: string, app: string): string {
  return `${action} needs the real pointer. It brings ${app} to the front and takes the pointer of the person at the machine for a moment, then puts both back. Send it again with args: { foreground: true }.`;
}
