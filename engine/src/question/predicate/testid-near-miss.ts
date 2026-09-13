/**
 * Turning "no element matched {testid: …}" into something an agent can act on.
 *
 * `reticle_query` on a missing testid already returns the testids that ARE present, so a typo is one
 * step from fixed. The same failure through a PREDICATE — `act_and_wait { until: { kind:'element',
 * query:{ testid } } }` — said only "no element matched" and stopped, naming nothing.
 *
 * The near-miss machinery covered an element in the wrong STATE and a wrong NAME for a role (which
 * even lists the names it saw). Testid — the anchor this codebase calls the gold standard — had
 * none, and it is the one agents use most.
 *
 * It also just became the highest-traffic failure in the product: putting act_and_wait on the
 * verification path means agents assert far more, so a failed element assertion is now the common
 * case rather than the rare one.
 */

/** Enough to recognise the one you meant; not so many that a large page floods the message. */
const MAX_LISTED = 12;

/**
 * The "…but these ARE here" clause, or undefined when there is nothing useful to say.
 *
 * Returns the empty string when the queried testid is itself present: the miss was then about STATE,
 * not presence, and "you asked for X; X is present" reads as a contradiction rather than a hint.
 */
export function describeTestidMiss(wanted: string, present: readonly string[]): string | undefined {
  if (0 === present.length) return undefined;
  if (present.includes(wanted)) return '';
  const shown = present.slice(0, MAX_LISTED);
  const rest = present.length - shown.length;
  const tail = rest > 0 ? `, and ${String(rest)} more` : '';
  return `testids present here: ${shown.join(', ')}${tail}`;
}
