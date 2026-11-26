/**
 * The arrangements of `ActionType.WINDOW`: what a person does with the buttons of a window and the
 * Window menu. `left` and `right` fill that half of the screen, to put two windows side by side.
 * `zoom` fills the screen without full screen. `restore` undoes minimize and full screen.
 */
export const WindowArrangement = {
  MINIMIZE: 'minimize',
  ZOOM: 'zoom',
  FULLSCREEN: 'fullscreen',
  RESTORE: 'restore',
  LEFT: 'left',
  RIGHT: 'right',
} as const;
export type WindowArrangement = (typeof WindowArrangement)[keyof typeof WindowArrangement];

/** Why the page refuses `window`: only a desktop realm can move or resize a window. */
export const WINDOW_NEEDS_DESKTOP_MSG =
  'a page cannot move, resize, minimize or zoom its own window. Join the browser application as a ' +
  'desktop session (the computer realm) and arrange its window there.';
