/**
 * Everything refused BEFORE the action window opens.
 *
 * Both checks here share one property, and it is the reason they belong together: each is decidable
 * without touching the page, and each would otherwise be discovered only after the click had landed
 * — when the action is spent, the page has moved, and the honest answer has already been lost.
 *
 * Refusing early is not a convenience. `reticle_act_and_wait` promises a verdict, and a verdict that
 * blames the app for the caller's own mistake is the most damaging thing a verification tool can
 * produce: it sends somebody to fix code that is not broken. "Nothing was acted on" is a far better
 * outcome than "unknown".
 */
import { SessionReplacedError } from '../session/pending-commands.js';
import { assertNativeInputSupported } from './act-danger.js';
import { unevaluablePredicateReason } from '../events/predicate-precheck.js';

/**
 * Refuse a sequence whose steps cannot be acted on.
 *
 * `steps` is validated as a bare array of objects, so a step written with `target` — the locator the
 * single-action tools take — passes the schema, finds no `ref`, and is skipped. The call then returns
 * `steps: []` and no error: a whole login journey doing NOTHING while reporting success, which is the
 * exact failure this product exists to catch, in this product.
 *
 * Checked for every step before the first one runs, so a typo in step three does not leave steps one
 * and two already applied to the page.
 */
export function assertSequenceSteps(steps: readonly unknown[]): void {
  if (0 === steps.length) {
    throw new Error(
      'reticle_act_sequence was given no steps. Pass steps: [{ ref, action, args? }] — nothing was acted on.',
    );
  }
  steps.forEach((raw, i) => {
    const step = 'object' === typeof raw && null !== raw ? (raw as Record<string, unknown>) : {};
    if ('string' === typeof step['ref'] && step['ref'].length > 0) return;
    // `target` is addressed too, resolved per step through the same resolver `reticle_act` uses.
    // This used to refuse it with an explanation, which was the honest half-fix: the asymmetry it
    // explained still cost a round trip per field, which is the exact cost this tool exists to
    // remove (#702).
    if (step['target'] !== undefined) return;
    throw new Error(
      `step ${String(i)} has neither \`ref\` nor \`target\`. ` +
        'Address a step by ref (from reticle_query or reticle_snapshot) or by target ' +
        '(e.g. { testid } or { role, name }). ' +
        'Nothing was acted on — the whole sequence is refused so a bad step cannot leave the earlier ones half-applied.',
    );
  });
}

/**
 * Throws if this call cannot honestly be driven. Call it after the args are parsed and before the
 * first dispatch — anything that depends on what is actually rendered belongs after the action.
 */
export function preflightAct(actArgs: Record<string, unknown>, until: unknown): void {
  // This path cannot honour a native-input request, and taking the argument and ignoring it told
  // the agent its trusted click had happened. See act-danger.
  assertNativeInputSupported(actArgs);
  const unevaluable = unevaluablePredicateReason(until);
  if (unevaluable !== undefined) throw new Error(unevaluable);
}

/**
 * Dispatch a write, or report that its outcome went unobserved.
 *
 * Returns null — never throws — when the transport was displaced by a newer connection claiming the
 * same id. That happens on any full-document navigation the act itself causes: the page unloads,
 * re-announces, and the write in flight is rejected by the handle that just died.
 *
 * The write is deliberately NOT re-sent. Re-asking a READ on the successor is free; re-sending a
 * WRITE is not, because nothing can prove the first one did not reach the page — and a duplicated
 * click on a button that charges a card is a far worse outcome than a verdict of "I could not see".
 * Every other failure propagates unchanged: only a replacement is an observation problem, and
 * treating a timeout or a refusal as one would launder a real failure into a shrug.
 */
export async function dispatchAct<T>(send: () => Promise<T>): Promise<T | null> {
  try {
    return await send();
  } catch (error: unknown) {
    if (error instanceof SessionReplacedError) return null;
    throw error;
  }
}
