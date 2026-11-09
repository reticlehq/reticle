import { ActionType } from './constants/constants.js';
import { pressModifiersFromArgs } from './global-press.js';

/** The pointer buttons a click can use, as the agent spells them in `args.button`. */
export const ClickButton = {
  LEFT: 'left',
  MIDDLE: 'middle',
  RIGHT: 'right',
} as const;
export type ClickButton = (typeof ClickButton)[keyof typeof ClickButton];

const CLICK_BUTTON_NAMES: readonly string[] = Object.values(ClickButton);

/** The button a click asks for: left when `args.button` is absent, undefined when it is unknown. */
export function clickButtonFromArgs(args: Record<string, unknown>): ClickButton | undefined {
  const raw = args['button'];
  if (raw === undefined) {
    return ClickButton.LEFT;
  }
  if ('string' !== typeof raw) {
    return undefined;
  }
  const name = raw.toLowerCase();
  return CLICK_BUTTON_NAMES.find((known) => known === name) as ClickButton | undefined;
}

/**
 * Why a click or dblclick cannot be driven as asked, or undefined when it can. The page and the
 * server both refuse with this sentence, so an argument is never dropped without a word.
 */
export function clickInputProblem(
  action: ActionType,
  args: Record<string, unknown>,
): string | undefined {
  const button = clickButtonFromArgs(args);
  if (button === undefined) {
    return `unsupported click button ${JSON.stringify(args['button'])}: use ${CLICK_BUTTON_NAMES.join(', ')}`;
  }
  if (action === ActionType.DBLCLICK && button !== ClickButton.LEFT) {
    return 'a dblclick uses the left button only: a browser sends no dblclick for another button';
  }
  const raw = args['modifiers'];
  if (Array.isArray(raw)) {
    const unknown = raw.filter(
      (item) => 0 === pressModifiersFromArgs({ modifiers: [item] }).length,
    );
    if (0 < unknown.length) {
      return `unsupported click modifier ${JSON.stringify(unknown[0])}: use Meta, Control, Shift or Alt`;
    }
  }
  return undefined;
}

/*
 * A point inside the target element, for a pointer action.
 *
 * A canvas has no child elements, so the centre of its box was the only place a pointer action could
 * land, and a game on a canvas could not be played. `args.at` names a point as fractions of the
 * element's box: `{ x: 0.25, y: 0.75 }` is a quarter of the way across and three quarters of the way
 * down. A drag also takes `args.to`, the end point as fractions of the drop target's box, or of the
 * source's box when there is no drop target, so a drag can move inside one canvas.
 *
 * The page and the server read and refuse a point with these functions, so a point is never
 * honoured on one path and dropped on the other. The check is plain code, not a zod schema: the
 * page runs it, and a zod parse in the page adds about 420 KB to the first load of every page.
 */

/** The act argument for a point inside the target element. */
export const ACT_POINT_ARG = 'at';
/** The drag argument for the end point inside the drop target, or inside the source. */
export const DRAG_TO_POINT_ARG = 'to';

/** A point as fractions of a box: 0 is the left or top edge, 1 the right or bottom edge. */
export interface BoxFraction {
  x: number;
  y: number;
}

/** The actions that land at a point. */
const POINT_ACTIONS: ReadonlySet<string> = new Set([
  ActionType.CLICK,
  ActionType.DBLCLICK,
  ActionType.HOVER,
  ActionType.TAP,
  ActionType.DRAG,
]);

const isFiniteNumber = (n: unknown): n is number => 'number' === typeof n && Number.isFinite(n);

/** `{ x, y }` with two finite numbers, as given, or undefined. */
function readBoxFraction(raw: unknown): BoxFraction | undefined {
  if ('object' !== typeof raw || null === raw || Array.isArray(raw)) {
    return undefined;
  }
  const { x, y } = raw as Record<string, unknown>;
  return isFiniteNumber(x) && isFiniteNumber(y) ? { x, y } : undefined;
}

const clampFraction = (n: number): number => Math.min(1, Math.max(0, n));

/** The point under `key`, each fraction clamped to 0..1, or undefined when absent or unreadable. */
export function boxFractionFromArgs(
  args: Record<string, unknown>,
  key: typeof ACT_POINT_ARG | typeof DRAG_TO_POINT_ARG,
): BoxFraction | undefined {
  const point = readBoxFraction(args[key]);
  return point === undefined ? undefined : { x: clampFraction(point.x), y: clampFraction(point.y) };
}

/** The point at `at` in `box`, in the coordinates of the box. */
export function pointInBox(
  box: { x: number; y: number; width: number; height: number },
  at: BoxFraction,
): { x: number; y: number } {
  return { x: box.x + box.width * at.x, y: box.y + box.height * at.y };
}

/**
 * Why `at` or `to` cannot be honoured on this action, or undefined when it can or is absent. A point
 * that is not two numbers is refused: an action at the centre is not the action that was asked for.
 */
export function actPointProblem(action: string, args: Record<string, unknown>): string | undefined {
  for (const key of [ACT_POINT_ARG, DRAG_TO_POINT_ARG] as const) {
    if (args[key] === undefined) {
      continue;
    }
    if (DRAG_TO_POINT_ARG === key && ActionType.DRAG !== action) {
      return `\`${key}\` is the end point of a drag only: use \`${ACT_POINT_ARG}\` for a point of a ${action}`;
    }
    if (!POINT_ACTIONS.has(action)) {
      return `\`${key}\` is a point for a pointer action (${[...POINT_ACTIONS].join(', ')}), not for a ${action}`;
    }
    if (readBoxFraction(args[key]) === undefined) {
      return `\`${key}\` must be { x, y }: two numbers, each a fraction of the element's box from 0 to 1`;
    }
  }
  return undefined;
}
