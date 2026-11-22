/**
 * The words of a history move: `reticle_navigate { history }` and the `history` command it sends.
 *
 * Kept apart from `constants.ts`: one small group with a reader on each side of the wire, and
 * nothing else in that file depends on it.
 *
 * A synthetic Alt+ArrowLeft does not move a tab through its history, and a URL navigation adds an
 * entry instead of moving along the ones there are. So a bug such as "Back after a form submit
 * shows the wrong page" had no tool that could reproduce it (#1844).
 */
export const NavigateHistory = {
  BACK: 'back',
  FORWARD: 'forward',
} as const;
export type NavigateHistory = (typeof NavigateHistory)[keyof typeof NavigateHistory];

/** The argument of the `history` command that holds a `NavigateHistory`. */
export const HISTORY_DIRECTION_ARG = 'direction';

/** Why the page did not move through its history. Sent as `reason` on an `ok:false` result. */
export const NavigateHistoryRefusal = {
  /** The direction is not a `NavigateHistory` value. */
  UNKNOWN_DIRECTION: 'history direction must be "back" or "forward"',
  /** The browser reports no entry in that direction, so the page cannot move. */
  NO_ENTRY: 'the tab has no history entry in that direction',
} as const;
export type NavigateHistoryRefusal =
  (typeof NavigateHistoryRefusal)[keyof typeof NavigateHistoryRefusal];
