/**
 * How a starved tab qualifies a verdict.
 *
 * Split out of predicate.ts, which was at the 1000-line cap: this is one cohesive question (when
 * does "the browser did not let this tab run" undermine what we just read) and it reads better
 * beside its own reasoning than buried among the oracles.
 */
import { THROTTLED_STARVED_NOTE } from '@reticlehq/core';
import { isAbsenceClaim } from '../honesty/blind-spots.js';
import type { EvalResult, Predicate } from './predicate-eval.js';

/** The only thing this needs from a session. A fake that never throttles simply omits it. */
export interface ThrottleReadable {
  throttled?(): boolean;
}

/**
 * A miss on a throttled tab is not a missing render. The browser has starved the tab, so a timeout
 * there may mean it never ran, which must not look like "the text is absent".
 *
 * The caveat is about not having been able to LOOK, so it belongs on whichever verdict rests on
 * having found NOTHING. For an ordinary predicate that is the failure. For an absence claim the
 * polarity inverts, and both halves of that were wrong:
 *
 *  - A FAILED absence claim found matching elements. Elements that were found were found, and a
 *    starved tab is no reason to doubt them. Downgrading it reported `unknown` for a framework error
 *    page whose "ProgrammingError" heading Reticle had just matched thirteen times, and an agent
 *    reading `unknown` re-drives or moves on instead of reporting the failure it proved.
 *  - A PASSING absence claim found nothing, which is exactly the reading a starved tab undermines.
 *    That one was never annotated at all, so "I could not look" and "it is not there" were the same
 *    green.
 *
 * Sets `inconclusive` only. The PROSE is already handled one layer up by `annotateStarvedFailure`
 * (session-health.ts), which suffixes the same fact onto the failureReason so the concrete diagnosis
 * still leads; writing it here as well would put the sentence in every throttled failure twice. What
 * was missing was never the sentence, it was the FIELD an agent gates on, so a starved wait graded
 * `assertion-failed` and sent somebody to fix working code. `decideVerified` reads `inconclusive`
 * ahead of both the pass and the failure clause, so it grades UNKNOWN either way round.
 *
 * Idempotent, and a more specific `inconclusive` (unreadable locator, superseded window) is never
 * overwritten.
 */
export function annotateThrottledMiss(
  session: ThrottleReadable,
  predicate: Predicate,
  result: EvalResult,
): EvalResult {
  if (true !== session.throttled?.()) return result;
  const restsOnHavingFoundNothing = isAbsenceClaim(predicate) ? result.pass : !result.pass;
  if (!restsOnHavingFoundNothing) return result;
  if (result.inconclusive !== undefined) return result;
  return { ...result, inconclusive: THROTTLED_STARVED_NOTE };
}
