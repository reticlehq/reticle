import { ActionType, WindowArrangement } from '@reticlehq/core';

import { ActKind, Delivery } from '../driver.js';
import type { ActOutcome, WindowState } from '../driver.js';
import { UiRole } from '../ui-node.js';
import type { UiNode } from '../ui-node.js';
import { see } from './seen.js';
import type { Seen } from './seen.js';
import type { ActResult } from './form.js';
import type { SelectContext } from './select.js';

/** How long the window may move before the answer: macOS animates a zoom and a minimize. */
const WINDOW_SETTLE_MS = 1200;
const ARRANGEMENTS: readonly string[] = Object.values(WindowArrangement);
/** The value the helper takes for an exact frame: "frame:x,y,width,height". */
const FRAME_PREFIX = 'frame:';

/** What the helper is asked to do with the window, from `args.arrange` or `args.frame`. */
export function windowValue(more: Record<string, unknown>): string {
  const arrange = more['arrange'];
  if ('string' === typeof arrange && ARRANGEMENTS.includes(arrange)) {
    return arrange;
  }
  const frame = more['frame'];
  if ('object' === typeof frame && null !== frame) {
    const { x, y, width, height } = frame as Record<string, unknown>;
    const numbers = [x, y, width, height];
    if (numbers.every((n) => 'number' === typeof n && Number.isFinite(n))) {
      return `${FRAME_PREFIX}${numbers.map(String).join(',')}`;
    }
  }
  throw new Error(
    `window needs args.arrange, one of: ${ARRANGEMENTS.join(', ')}; or args.frame: { x, y, width, height } in screen points.`,
  );
}

/** The window as the answer gives it: from the helper's read of it, or from the tree after. */
export interface WindowAnswer {
  x: number;
  y: number;
  width: number;
  height: number;
  minimized: boolean;
  fullscreen: boolean;
}

/** The frame of the window that holds the element: the window whose path starts the element's. */
function frameInTree(
  root: UiNode,
  target: Seen,
): readonly [number, number, number, number] | undefined {
  const holds = (path: readonly number[]): boolean =>
    path.length <= target.path.length && path.every((step, i) => step === target.path[i]);
  return see(root)
    .filter((s) => s.node.role === UiRole.WINDOW && holds(s.path))
    .sort((a, b) => b.path.length - a.path.length)[0]?.node.frame;
}

function answerOf(outcome: ActOutcome, target: Seen): WindowAnswer | undefined {
  const state = outcome.windowState;
  const frame = state?.frame ?? frameInTree(outcome.after.root, target);
  if (frame === undefined) {
    return undefined;
  }
  return {
    x: frame[0],
    y: frame[1],
    width: frame[2],
    height: frame[3],
    minimized: state?.minimized ?? false,
    fullscreen: state?.fullscreen ?? false,
  };
}

/** How far a frame may be from the one asked for: the system rounds to whole points. */
const FRAME_SLACK = 2;

/**
 * What is not as asked, after the change, in words. Absent: the window is as asked. The answer of
 * the system to the set is not the proof: an application with no tile in the Dock says yes to
 * minimize, and its window stays where it was. A window with a smallest size does not take half
 * of a small screen.
 */
function notAsAsked(value: string, state: WindowState | undefined): string | undefined {
  if (state === undefined) {
    return 'was not read after the change, so nothing proves that it changed.';
  }
  if (value === WindowArrangement.MINIMIZE && !state.minimized) {
    return 'did not go to the Dock: it is still on the screen.';
  }
  if (value === WindowArrangement.FULLSCREEN && !state.fullscreen) {
    return 'did not go to full screen.';
  }
  if (value === WindowArrangement.RESTORE && (state.minimized || state.fullscreen)) {
    return `is still ${state.minimized ? 'minimized' : 'in full screen'}.`;
  }
  const { frame, wanted } = state;
  if (wanted !== undefined) {
    const off =
      frame === undefined || wanted.some((n, i) => Math.abs(n - (frame[i] ?? n)) > FRAME_SLACK);
    if (off) {
      return `did not take the frame ${wanted.join(',')}: it is ${frame?.join(',') ?? 'not on the screen'}. The window can have a smallest or a largest size.`;
    }
  }
  return undefined;
}

/**
 * On the application element it arranges the main window, and `restore` brings back the window
 * that is minimized or in full screen: a minimized window is not on the screen and has no ref.
 *
 * Arranges the window of the element, as a person does with the buttons of a window and the
 * Window menu. No pointer is used: the helper sets the window through the Accessibility API, so it
 * works in the background too. The answer gives the frame of the window after the change, which
 * is the proof, with `minimized` and `fullscreen`: a minimized window keeps its frame, so the
 * frame alone does not say that it went to the Dock.
 */
export async function arrangeWindow(
  ctx: Pick<SelectContext, 'drive'>,
  target: Seen,
  ref: string,
  more: Record<string, unknown>,
): Promise<ActResult> {
  const value = windowValue(more);
  const { outcome, changes } = await ctx.drive(target, ref, ActKind.WINDOW, value, {
    delivery: Delivery.DIRECT,
    budgetMs: WINDOW_SETTLE_MS,
  });
  const window = answerOf(outcome, target);
  const wrong = notAsAsked(value, outcome.windowState);
  if (wrong !== undefined) {
    throw new Error(`the window of ${target.node.name || 'the element'} ${wrong}`);
  }
  return {
    ...(window === undefined ? {} : { window }),
    ok: true,
    ref,
    action: ActionType.WINDOW,
    dispatched: true,
    settled: outcome.settled,
    settleReason: null,
    effect: { dispatched: true, targetMatched: true, domMutatedWithin: changes.length },
    role: target.node.role,
    name: target.node.name,
  };
}
