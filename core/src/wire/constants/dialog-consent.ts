/**
 * Which `confirmDangerous` answers the app's own `confirm()` with yes (#2167).
 *
 * Kept apart from `constants.ts`, which is at the 1000-line cap. The SDK reads it for a dispatched
 * action, and the server reads it for a real key press on a leased tab.
 *
 * `reticle_act_and_wait` names "Delete" and an `until`, and the server takes that declaration as the
 * confirmation: it sets `confirmDangerous` so that the control can be pressed. That flag is not the
 * caller's yes to the dialog the press opens, so the server marks it with
 * `DANGER_CONFIRMED_BY_DECLARATION_ARG`.
 */
import { DANGEROUS_ACTION_CONFIRM_ARG } from './constants.js';

/** Set by the server beside `confirmDangerous` when a declaration, not the caller, confirmed. */
export const DANGER_CONFIRMED_BY_DECLARATION_ARG = 'confirmedByDeclaration';

/** The caller itself set `confirmDangerous`: only then is the action's `confirm()` answered yes. */
export function confirmsDialog(args: Readonly<Record<string, unknown>>): boolean {
  return (
    true === args[DANGEROUS_ACTION_CONFIRM_ARG] &&
    true !== args[DANGER_CONFIRMED_BY_DECLARATION_ARG]
  );
}
