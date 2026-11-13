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

interface Consent {
  /** False once a `confirm()` has used this yes. */
  open: boolean;
}

/** The actions in flight that carry a yes. */
const consents = new Set<Consent>();
/** How many actions without a yes are in flight. */
let plainInFlight = 0;

/** Run one action's dispatch, with a yes for its `confirm()` when `given` is true. */
export async function withDialogConsent<T>(given: boolean, dispatch: () => Promise<T>): Promise<T> {
  if (!given) {
    plainInFlight += 1;
    try {
      return await dispatch();
    } finally {
      plainInFlight -= 1;
    }
  }
  const consent: Consent = { open: true };
  consents.add(consent);
  try {
    return await dispatch();
  } finally {
    consents.delete(consent);
  }
}

/** True, once, when the one action in flight carries an unused yes. */
export function takeDialogConsent(): boolean {
  if (0 < plainInFlight || 1 !== consents.size) {
    return false;
  }
  const [consent] = consents;
  if (consent === undefined || !consent.open) {
    return false;
  }
  consent.open = false;
  return true;
}
