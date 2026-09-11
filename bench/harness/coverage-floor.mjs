/**
 * Did this run measure as much of the grid as the last one, or did coverage quietly shrink?
 *
 * A cell that times out or throws is recorded `NOT MEASURED`, and NOT MEASURED cells are EXCLUDED
 * from the catch-rate denominator rather than counted as misses. That exclusion is correct — a
 * scenario nobody could inject is not a miss, and counting it as one would understate every tool
 * equally — but it has a cost nothing was watching. The rate is computed over what SURVIVED. Lose a
 * cell and the catch-rate does not move; lose ten and it still does not move. Coverage can fall to a
 * single cell while the headline reads exactly as it did over thirty, and the gate passes every time.
 *
 * `verifyAnchors()` catches the one way a scenario can vanish that is visible before the run — a
 * regression whose anchor no longer matches the fixture — and it only runs under `--full`. Nothing
 * caught the ways a cell dies DURING the run.
 *
 * Both numbers this needs were already recorded in every history row. Nothing compared them.
 *
 * ## Why the tolerance is zero
 *
 * `measured_cells` is a count of grid cells, not a measurement of anything physical. It does not
 * drift, it does not have run-to-run noise, and it cannot fall by accident: a cell is lost because
 * something broke or something was removed. A tolerance here would only buy silence for the first
 * few losses, which is exactly the window in which a lost cell is cheapest to fix.
 *
 * A deliberate shrink is still allowed — DECLARED, the same way `token-budget.mjs` handles a
 * deliberate rise in cost, and for the same reason: a gate that cannot tell "we chose this" from "we
 * regressed" will either block honest work or be muted, and both end the same way.
 *
 * ## What this does NOT catch
 *
 * An equal count over a DIFFERENT set of cells — one lost, one gained. The count holds and the
 * composition changed. `not_measured` is printed with the failure so the swap is visible to a human
 * reading the diff, but it is not gated: which cells are hard to measure is a moving target, and a
 * gate on the exact set would fire on every honest scenario edit.
 *
 * Separate from `gate.mjs` so this logic is unit-tested. The gate has no test harness of its own,
 * which is exactly why the rules it enforces should not live inside it.
 */

function cells(row) {
  const n = row?.measured_cells;
  return 'number' === typeof n && Number.isFinite(n) ? n : null;
}

/**
 * Compare measured coverage against the baseline.
 *
 * `declaredDrop` is the prose reason this run is allowed to measure less — supplied by the caller
 * from the fresh artifact, so the justification lives with the run it justifies.
 */
export function coverageVerdict({ now, last, declaredDrop } = {}) {
  const fresh = cells(now);
  const baseline = cells(last);

  if (null === baseline) return { ok: true, reason: 'no baseline coverage to compare against' };

  if (null === fresh) {
    return {
      ok: false,
      reason:
        `this run did not record how many cells it measured (baseline ${String(baseline)}), so it ` +
        `cannot be shown not to have shrunk. An unmeasurable coverage number is not a coverage ` +
        `number — re-run the observation pass rather than reading this as unchanged.`,
    };
  }

  if (fresh >= baseline) {
    return {
      ok: true,
      reason: `${String(fresh)} cells measured vs ${String(baseline)} — no shrink`,
    };
  }

  const missing = Array.isArray(now?.not_measured) ? now.not_measured : [];
  const listed = missing.length > 0 ? ` Not measured this run: ${missing.join(', ')}.` : '';

  if ('string' === typeof declaredDrop && declaredDrop.length > 0) {
    return {
      ok: true,
      reason:
        `coverage fell from ${String(baseline)} to ${String(fresh)} cells and that was declared: ` +
        `${declaredDrop}${listed}`,
    };
  }

  return {
    ok: false,
    reason:
      `measured coverage SHRANK: ${String(fresh)} cells this run vs ${String(baseline)} in the ` +
      `baseline.${listed} A lost cell leaves the denominator rather than counting as a miss, so ` +
      `every rate below stays exactly where it was while the grid it is computed over gets smaller — ` +
      `the numbers keep their shape and stop meaning what they meant. Fix the cell, or, if the ` +
      `scenario went on purpose, declare it as { coverage: { dropped_because } } on this run's ` +
      `analysis and say what went and why.`,
  };
}
