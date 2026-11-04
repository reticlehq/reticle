/**
 * The native dialogs of one leased page: how each is answered, and the last one's message.
 *
 * The pool answers every native dialog on a lease, so that the page cannot wedge (#786). It
 * dismisses them. A real key press on a lease (`pressLease`) can open one: Enter submits a form whose
 * handler asks `confirm()`. The SDK never sees that dialog, because a trusted key is not one of its
 * own dispatches, so the pool answers it.
 *
 * `confirmDangerous: true` on the action is the caller's yes to that `confirm()` (#2167). It follows
 * the same rules as the SDK's `takeDialogConsent`: one `confirm` of that press only, and no when
 * another press without the yes is in flight beside it. `alert`, `prompt` and `beforeunload` are
 * always dismissed.
 */
import type { PooledDialog } from './pool-contract.js';

/** The `type` a pooled dialog reports for `window.confirm`. */
export const CONFIRM_DIALOG = 'confirm';

interface Consent {
  /** False once a `confirm` has used this yes. */
  open: boolean;
}

export class LeaseDialogs {
  /**
   * The message of the most recent dialog answered on this lease, if any.
   *
   * One string, overwritten — not a buffer: this is diagnostic context for "why did the page look
   * frozen for a moment", not a log an agent needs to replay.
   */
  lastMessage: string | undefined;
  readonly #consents = new Set<Consent>();
  #plainInFlight = 0;

  /** Run one press, with a yes for its `confirm` when `given` is true. */
  async during<T>(given: boolean, press: () => Promise<T>): Promise<T> {
    if (!given) {
      this.#plainInFlight += 1;
      try {
        return await press();
      } finally {
        this.#plainInFlight -= 1;
      }
    }
    const consent: Consent = { open: true };
    this.#consents.add(consent);
    try {
      return await press();
    } finally {
      this.#consents.delete(consent);
    }
  }

  /**
   * Accept the dialog when it is a `confirm` the press in flight said yes to, else dismiss it.
   *
   * A page that cannot accept (no `accept`, or no `type` to tell a `confirm` apart) is dismissed,
   * and the yes stays unused.
   */
  answer(dialog: PooledDialog): Promise<void> {
    this.lastMessage = dialog.message;
    if (dialog.accept !== undefined && CONFIRM_DIALOG === dialog.type && this.#take()) {
      return dialog.accept();
    }
    return dialog.dismiss();
  }

  /** True, once, when the one press in flight carries an unused yes. */
  #take(): boolean {
    if (0 < this.#plainInFlight || 1 !== this.#consents.size) {
      return false;
    }
    const [consent] = this.#consents;
    if (consent === undefined || !consent.open) {
      return false;
    }
    consent.open = false;
    return true;
  }
}
