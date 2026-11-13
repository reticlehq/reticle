/**
 * The positive yes to the app's own `confirm()` (#2167).
 *
 * Kept apart from `constants.ts`, which is at the 1000-line cap. The SDK reads it for a dispatched
 * action, and the server reads it for a real key press on a leased tab.
 *
 * `confirmDangerous` only lets a destructive control be pressed. Server paths set it for a whole run
 * (a crawl, a flow replay, a declaration in `reticle_act_and_wait`), so it cannot also be the yes.
 * The yes is this separate argument, and only `reticle_act`, `reticle_act_and_wait` and
 * `reticle_act_sequence` set it, when the caller itself passed `confirmDangerous`. Every other path
 * leaves it out, so a `confirm()` there is answered no. An SDK that meets an older daemon gets no
 * such argument and answers no too.
 */

/** Set by the server on an action whose caller passed `confirmDangerous`: a yes to its `confirm()`. */
export const DIALOG_CONSENT_ARG = 'acceptConfirm';

/** The `kind` of a native `window.confirm` dialog, the only kind the yes applies to. */
export const CONFIRM_DIALOG_KIND = 'confirm';
