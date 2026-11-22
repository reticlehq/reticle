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
