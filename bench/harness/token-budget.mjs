/**
 * Whether a rise in per-run replay tokens was chosen or merely happened.
 *
 * The gate cannot tell those apart on its own, and they need opposite responses. Reticle is adding
 * context deliberately — instrumentation gaps, observability, intent — and each costs bytes on
 * purpose. But loosening the tolerance to make room for that would remove the only thing that
 * catches the other kind, and the other kind is real: read-only calls are roughly half the tool
 * surface and the two largest payloads we emit are both reads. That is slack, not intent, and
 * nothing else in the repo would notice it growing.
 *
 * So: a deliberate rise is DECLARED, not absorbed. The 2.9.0 history row already does this in prose
 * — it documents a +16% rise, names the feature that caused it, and verifies it against the pre-merge
 * build. This turns that paragraph into a field the gate can read.
 *
 * ## Two properties that keep it honest
 *
 * **A budget is spent, not standing.** It is measured against the LAST row, so declaring +50 once
 * does not license +50 again on every release after it. Otherwise the ceiling ratchets and the gate
 * quietly stops meaning anything, which is worse than not having it.
 *
 * **An unreadable budget is zero, never unlimited.** A corrupt or half-written row must not turn
 * into a permanently open gate — the failure that costs the most is the one that looks like a pass.
 *
 * Separate from `gate.mjs` so this logic is unit-tested. The gate itself has no test harness, which
 * is exactly why the rule it enforces should not live inside it.
 */

/** Per-run replay tokens may rise this much against the last row before it counts as drift. */
export const TOKEN_TOL = 0.05;

/**
 * The extra tokens a row declared it intends to spend, in absolute terms.
 *
 * Absolute rather than a percentage on purpose: "this feature adds about forty tokens to a reply" is
 * a claim somebody can check against the diff, and "+15%" is not.
 */
export function declaredBudgetOf(row) {
  const declared = row?.cost?.token_budget?.extra_tokens;
  if ('number' !== typeof declared || !Number.isFinite(declared) || declared <= 0) return 0;
  return declared;
}

/**
 * Did per-run tokens move more than was allowed for?
 *
 * Returns `{ ok, reason }` rather than throwing, so the caller decides whether a failure is fatal —
 * the gate collects several and reports them together rather than dying on the first.
 */
export function tokenVerdict({ now, last, budget }) {
  if (null === last || undefined === last || null === now || undefined === now) {
    return { ok: true, reason: 'no baseline to compare against' };
  }
  const allowed = last * (1 + TOKEN_TOL) + (budget ?? 0);
  if (now <= allowed) return { ok: true, reason: 'within tolerance and declared budget' };

  const overrun = Math.round(now - allowed);
  const declared =
    0 === (budget ?? 0)
      ? 'undeclared — no `cost.token_budget` on the fresh row'
      : `over its declared budget of +${String(budget)}`;
  return {
    ok: false,
    reason:
      `per-run replay tokens ${String(now)} vs ${String(last)} is ${declared}, by ${String(overrun)} ` +
      `tokens beyond the 5% noise tolerance. A rise somebody CHOSE is not a regression — declare it ` +
      `as { cost: { token_budget: { extra_tokens, reason } } } on this run's row and say what buys ` +
      `it. A rise nobody chose is the thing this gate exists for.`,
  };
}
