/**
 * Did the caller of the action in flight say yes to a `confirm()` in advance (#2167)?
 *
 * Reticle answers a `confirm()` that its own dispatch opens with no, so that the tab cannot wedge
 * (see `observers/dialogs.ts`). A destructive flow behind a confirm then cannot be driven through
 * its button. `confirmDangerous: true` on the action is the caller's yes, stated up front.
 *
 * The yes is narrow on purpose:
 * - It is spent on ONE `confirm()`. A second one in the same dispatch ("Are you really sure?") is
 *   declined, because the caller agreed to one question, not to every question the app asks.
 * - It ends when the dispatch ends. The next action starts with no.
 * - It applies only when the action is the only one in flight. Actions can overlap (a held click
 *   awaits between pointerdown and pointerup), and a `confirm()` during the overlap cannot be
 *   given to one action or the other. No is the safe answer.
 *
 * The caller of `isSyntheticInput()` still decides whether the dialog is Reticle's at all. A dialog
 * a person opens is never answered here.
 */

/** How many actions are in flight, with a yes or without one. */
let inFlight = 0;
/** The actions in flight whose yes is still unused, one token each. */
const unused = new Set<object>();

/** Run one action's dispatch, with a yes for its `confirm()` when `given` is true. */
export async function withDialogConsent<T>(given: boolean, dispatch: () => Promise<T>): Promise<T> {
  const token = {};
  inFlight += 1;
  if (given) {
    unused.add(token);
  }
  try {
    return await dispatch();
  } finally {
    inFlight -= 1;
    unused.delete(token);
  }
}

/** True, once, when the one action in flight carries an unused yes. */
export function takeDialogConsent(): boolean {
  if (1 !== inFlight || 1 !== unused.size) {
    return false;
  }
  unused.clear();
  return true;
}
