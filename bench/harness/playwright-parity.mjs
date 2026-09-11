/**
 * Does Reticle still catch more than Playwright, and still cost less to do it?
 *
 * Every other gated dimension compares us against OURSELVES — catch-rate, efficiency and replay
 * tokens are all measured against the previous row. Those catch a regression, and none of them would
 * notice the day our numbers drift past Playwright's, because the two are never compared. The most
 * quotable claim this product makes is the one nothing defends.
 *
 * ## The two halves are deliberately not symmetric
 *
 * **Detection below Playwright's is a hard failure.** It is the thesis, not a metric: a verification
 * layer that catches less than the tool it claims to beat has no argument left, and no amount of
 * token saving redeems it. There is no declared override for this half, on purpose — a budget buys
 * bytes, it does not buy the claim.
 *
 * **Costing more than Playwright is a positioning change.** That may genuinely be the right trade
 * for context that earns it — intent, gaps, observability all cost bytes deliberately. So it can be
 * declared. What it cannot be is drifted into silently across three releases until somebody notices
 * the headline no longer holds.
 *
 * Absent measurements FAIL rather than pass. A green that means "we did not measure" is the worst
 * outcome available here, because it reads exactly like a green that means "we checked".
 */

/** Run-to-run noise on a 12-scenario sample; below this a token difference is not a signal. */
const NOISE_TOL = 0.02;

function measured(value) {
  return 'number' === typeof value && Number.isFinite(value);
}

/**
 * Compare the two columns of the observation pass.
 *
 * `declaredCostlier` is the prose reason a run is allowed to cost more than Playwright — supplied by
 * the caller from the fresh row, so the justification lives with the measurement it justifies rather
 * than in a commit message nobody reads next year.
 */
export function parityVerdict({ reticle, playwright, declaredCostlier } = {}) {
  const ourTokens = reticle?.avg_tokens_o200k;
  const theirTokens = playwright?.avg_tokens_o200k;
  const ourDetection = reticle?.detection_accuracy;
  const theirDetection = playwright?.detection_accuracy;

  if (
    !measured(ourTokens) ||
    !measured(theirTokens) ||
    !measured(ourDetection) ||
    !measured(theirDetection)
  ) {
    return {
      ok: false,
      reason:
        'Reticle vs Playwright was not measured on this run, so parity is unknown. Treating that as a ' +
        'pass would be a green that means "we did not look", which reads identically to one that means ' +
        '"we checked". Run the observation pass (`bench-all --full`) before gating.',
    };
  }

  if (ourDetection < theirDetection) {
    return {
      ok: false,
      reason:
        `Reticle catches less than Playwright: ${String(ourDetection)} vs ${String(theirDetection)} ` +
        `detection accuracy. This is the product's central claim, not a metric, and there is no ` +
        `declared override for it — a token budget buys bytes, not the thesis.`,
    };
  }

  if (ourTokens > theirTokens * (1 + NOISE_TOL)) {
    if ('string' === typeof declaredCostlier && declaredCostlier.length > 0) {
      return {
        ok: true,
        reason:
          `Reticle costs more than Playwright (${String(ourTokens)} vs ${String(theirTokens)}) and ` +
          `that was declared: ${declaredCostlier}`,
      };
    }
    return {
      ok: false,
      reason:
        `Reticle costs more than Playwright and nobody said it would: ${String(ourTokens)} vs ` +
        `${String(theirTokens)} average tokens. Catching more while costing less is the claim this ` +
        `product is sold on, so losing half of it is a positioning change and should be a decision. ` +
        `If the extra bytes buy something, declare it as ` +
        `{ cost: { playwright_parity: { costlier_because } } } on this run's row.`,
    };
  }

  return {
    ok: true,
    reason:
      `Reticle ${String(ourTokens)} tokens at ${String(ourDetection)} detection vs Playwright ` +
      `${String(theirTokens)} at ${String(theirDetection)} — cheaper and at least as complete.`,
  };
}
