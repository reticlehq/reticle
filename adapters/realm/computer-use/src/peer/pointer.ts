/**
 * The real pointer: which action of a tool is which gesture, what to say when a gesture needs
 * the foreground, and where on the screen a point of a picture of the window is.
 */
import {
  ACT_POINT_ARG,
  ActionType,
  DRAG_TO_PICTURE_POINT_ARG,
  DRAG_TO_POINT_ARG,
  PICTURE_POINT_ARG,
  boxFractionFromArgs,
  pointInBox,
} from '@reticlehq/core';

import { ActKind } from '../driver.js';
import { placeShown } from '../ui-node.js';
import type { UiNode } from '../ui-node.js';
import { KIND_OF } from './form.js';

/** Where a picture of the window was taken, and its pixels for each point of the screen. */
export interface Picture {
  /** What the picture shows on the screen: the window, or the whole display. */
  window: readonly [number, number, number, number];
  scale: number;
  /** The application's window when the picture was taken. */
  appWindow: readonly [number, number, number, number];
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
 * The point on the screen for a point of the last picture, in its pixels (`args.point`).
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
      'args.point is a point for the real pointer. Send it with args: { foreground: true } on click, dblclick, hover or drag.',
    );
  }
  if (picture === undefined) {
    throw new Error(
      'args.point is a point of a picture of the window, and no picture was taken. Take one first: reticle_screenshot.',
    );
  }
  const { window, scale } = picture;
  return `${String(window[0] + x / scale)},${String(window[1] + y / scale)}`;
}

/** What the helper says when the terminal may not record the screen. */
export const NO_SCREEN_RECORDING = 'no-screen-recording-permission';
/** The kinds that can go to a point of a picture, and not to the middle of an element. */
export const POINT_KINDS: ReadonlySet<string> = new Set([
  ActKind.CLICK,
  ActKind.DBLCLICK,
  ActKind.RIGHTCLICK,
  ActKind.HOVER,
  ActKind.DRAG,
  ActKind.WHEEL,
]);

type Frame = readonly [number, number, number, number];
const asPoint = (p: { x: number; y: number }): string => `${String(p.x)},${String(p.y)}`;
const boxOf = (f: Frame) => ({ x: f[0], y: f[1], width: f[2], height: f[3] });

/**
 * Refuses `at` or `to` when it is not a fraction from 0 to 1. A page moves such a point to the edge
 * of the box. Here a model that thinks in pixels of the screenshot sends `at: { x: 600, y: 400 }`,
 * and the edge was a click in the wrong place that reported done.
 */
function fractionOnly(more: Record<string, unknown>, key: string, pixelKey: string): void {
  const raw = more[key];
  if ('object' !== typeof raw || null === raw) {
    return;
  }
  const { x, y } = raw as Record<string, unknown>;
  const outside = [x, y].some((n) => 'number' === typeof n && (n < 0 || n > 1));
  if (outside) {
    throw new Error(
      `args.${key} is a fraction of the element's box, from 0 to 1. For a pixel of the last picture of the screen, use args.${pixelKey}.`,
    );
  }
}

/** Whether the act names a point of a picture: the picture can be old, so it is checked. */
export function usesPicture(more: Record<string, unknown>): boolean {
  return more[PICTURE_POINT_ARG] !== undefined || more[DRAG_TO_PICTURE_POINT_ARG] !== undefined;
}

/**
 * Where the pointer goes, as "x,y" on the screen: a point of the last picture (`point`), or a
 * point of the element's box (`at`, fractions from 0 to 1, as in a page). Absent: the middle.
 */
export function pointFor(
  picture: Picture | undefined,
  more: Record<string, unknown>,
  kind: ActKind,
  frame: Frame | undefined,
): string | undefined {
  fractionOnly(more, ACT_POINT_ARG, PICTURE_POINT_ARG);
  const fromPicture = pointOnScreen(picture, more[PICTURE_POINT_ARG], kind);
  if (fromPicture !== undefined) {
    return fromPicture;
  }
  const at = boxFractionFromArgs(more, ACT_POINT_ARG);
  if (at === undefined || frame === undefined) {
    return undefined;
  }
  if (!POINT_KINDS.has(kind)) {
    throw new Error(`args.${ACT_POINT_ARG} is a point for the real pointer, not for this action.`);
  }
  return asPoint(pointInBox(boxOf(frame), at));
}

/**
 * The value of a drag for the helper: "x,y" of the end, or "x,y,x,y" from a start to the end. The
 * end is a point of the last picture (`toPoint`), the middle of another element (`toRef`), or a
 * point of the element's own box (`to`), as a slider is dragged.
 */
export function dragValue(
  picture: Picture | undefined,
  more: Record<string, unknown>,
  frame: Frame | undefined,
  ontoFrame: Frame | undefined,
): string {
  fractionOnly(more, DRAG_TO_POINT_ARG, DRAG_TO_PICTURE_POINT_ARG);
  // A path of the picture: a stroke of a brush, a lasso, a curve. Each point is a point of the
  // last picture, as `point` is, and the drag goes through all of them in order.
  const path = more[PATH_ARG];
  if (Array.isArray(path)) {
    const points = path.map((p) => pointOnScreen(picture, p, ActKind.DRAG));
    if (points.length < 2 || points.some((p) => p === undefined)) {
      throw new Error(
        `args.${PATH_ARG} is a list of at least two points of the last picture: [{ x, y }, { x, y }, ...]. Take a picture with reticle_screenshot first.`,
      );
    }
    return points.join(',');
  }
  const start = pointFor(picture, more, ActKind.DRAG, frame);
  const to = boxFractionFromArgs(more, DRAG_TO_POINT_ARG);
  let end = pointOnScreen(picture, more[DRAG_TO_PICTURE_POINT_ARG], ActKind.DRAG);
  if (end === undefined && ontoFrame !== undefined) {
    end = asPoint({ x: ontoFrame[0] + ontoFrame[2] / 2, y: ontoFrame[1] + ontoFrame[3] / 2 });
  }
  if (end === undefined && to !== undefined && frame !== undefined) {
    end = asPoint(pointInBox(boxOf(frame), to));
  }
  if (end === undefined) {
    throw new Error(
      `${ActionType.DRAG} needs where to drag to: args: { toRef: "<ref>" }, { toPoint: { x, y } } in the pixels of the last picture, or { to: { x, y } } as fractions of the element's box.`,
    );
  }
  return start === undefined ? end : `${start},${end}`;
}
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

type Spot = readonly [number, number];

/**
 * Where the pointer of the HUD goes for an action: the place it starts, and for a drag the place
 * it ends, as a hand presses at one place and lets go at another. The start is the point of the
 * action when it has one, or the middle of the element. A drag gives "x,y" (the end) or "x,y,x,y"
 * (the start and the end), and a wheel gives "lines,x,y".
 */
export function pointerPath(
  kind: ActKind,
  value: string | undefined,
  frame: readonly [number, number, number, number] | undefined,
): { start?: Spot; end?: Spot } {
  // The points come before the hand ("|mods=..."), and a path has more than two.
  const n =
    (value ?? '')
      .split('|')[0]
      ?.split(',')
      .filter((x) => x !== '')
      .map(Number) ?? [];
  const pair = (at: number): Spot | undefined => {
    const [x, y] = [n[at], n[at + 1]];
    return x !== undefined && y !== undefined && Number.isFinite(x) && Number.isFinite(y)
      ? [x, y]
      : undefined;
  };
  const middle: Spot | undefined =
    frame === undefined ? undefined : [frame[0] + frame[2] / 2, frame[1] + frame[3] / 2];
  if (kind === ActKind.DRAG) {
    const fromPoint = n.length >= 4;
    const start = fromPoint ? pair(0) : middle;
    const end = pair(n.length - 2);
    return { ...(start === undefined ? {} : { start }), ...(end === undefined ? {} : { end }) };
  }
  let at: Spot | undefined;
  if (kind === ActKind.WHEEL) {
    at = 3 === n.length ? pair(1) : undefined;
  } else if (POINT_KINDS.has(kind) && 2 === n.length) {
    at = pair(0);
  }
  const start = at ?? middle;
  return start === undefined ? {} : { start };
}

/** A drag along points of the picture. */
export const PATH_ARG = 'path';
/** The keys held through a pointer action, as a key takes them: ["Shift", "Alt"]. */
const MODIFIERS_ARG = 'modifiers';
/** How long the button stays down before the pointer moves or lets go, in milliseconds. */
export const HOLD_ARG = 'holdMs';
const MAX_HOLD_MS = 10_000;

/**
 * How the hand holds a pointer action, after its points: "|mods=shift+alt|hold=300". The keys held
 * through a click or a drag (shift-click to add to a choice, option-drag for a copy) and the time
 * the button stays down. A click in the background is a press, which holds no key: it is refused,
 * as nothing else would show that the keys were not held.
 */
/** Roles whose effect can be only in pixels: a photo, a canvas, a frame of video, a window. */
const CANVAS_ROLES: ReadonlySet<string> = new Set(['img', 'group', 'window', 'application']);

/**
 * Whether the helper compares pictures of the window for this action. Only for a point of a
 * picture or an element that can be a canvas: each picture costs a wait for the window to draw,
 * and a button shows its effect in its elements.
 */
export function wantsPixels(role: string, more: Record<string, unknown>): boolean {
  return (
    CANVAS_ROLES.has(role) ||
    [PICTURE_POINT_ARG, PATH_ARG, DRAG_TO_PICTURE_POINT_ARG].some((key) => more[key] !== undefined)
  );
}

export function handOf(kind: ActKind, more: Record<string, unknown>, pixels = false): string {
  // A key press takes its modifiers in its key: only a pointer action takes a hand.
  if (kind === ActKind.KEY) {
    return '';
  }
  const keys = Array.isArray(more[MODIFIERS_ARG])
    ? (more[MODIFIERS_ARG] as unknown[]).map(String)
    : [];
  const hold =
    'number' === typeof more[HOLD_ARG] ? Math.min(MAX_HOLD_MS, Math.max(0, more[HOLD_ARG])) : 0;
  const compare = pixels && POINT_KINDS.has(kind) ? '|pixels=1' : '';
  if (0 === keys.length && 0 === hold) {
    return compare;
  }
  if (!POINT_KINDS.has(kind)) {
    throw new Error(
      `keys held through a click, and a held button, need the real pointer: add args.foreground: true. A ${kind} in the background holds no key.`,
    );
  }
  return `${0 === keys.length ? '' : `|mods=${keys.map((k) => k.toLowerCase()).join('+')}`}${0 === hold ? '' : `|hold=${String(hold)}`}${compare}`;
}
