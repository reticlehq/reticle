import { isVisible } from './a11y.js';
import { isReticleUi } from './dom-ignore.js';

/**
 * The APP's modal layer, in one selector.
 *
 * Three shapes, because three things put a dialog on screen: the platform (`<dialog>` opened with
 * `show()`/`showModal()`, which is the only one the browser itself will close), a library that
 * renders the role (Radix, Headless UI, MUI), and the ARIA an accessible custom modal declares.
 *
 * `snapshot.ts` asks the same question for a different reason — which of the app's dialogs to name
 * for the agent — and reads this constant so the two answers cannot drift. They must agree: the
 * snapshot telling an agent a dialog is open while the HUD still treats Escape as its own is the
 * shape of the bug this exists to stop.
 */
export const APP_DIALOG_SELECTOR = '[role="dialog"], dialog[open], [aria-modal="true"]';

/**
 * Is one of the app's dialogs open right now?
 *
 * Openness is read two ways because the two shapes state it differently. A native `<dialog>` says
 * so with the `open` attribute, which the selector already requires; a library's modal says so by
 * being on screen, since most of them leave the node mounted and hidden when closed. `isVisible`
 * covers both and costs a style walk per candidate — paid once per Escape keypress, on a selector
 * that matches nothing on the overwhelming majority of pages.
 *
 * Reticle's own chrome is excluded. The tour card carries `role="dialog"`, and counting it would
 * make Reticle stand down from its own key.
 */
export function appDialogIsOpen(root: ParentNode): boolean {
  for (const node of root.querySelectorAll(APP_DIALOG_SELECTOR)) {
    if (isReticleUi(node)) continue;
    if (isVisible(node)) return true;
  }
  return false;
}
