/**
 * Which tools this run actually measured — and the denominator each of them was graded over.
 *
 * Zero and absent are different facts, and the analysis conflated them. The observation pass
 * measures the tools named in `BENCH_TOOLS`; the analysis iterated a longer hard-coded list. A tool
 * that never ran therefore got a complete per-tool block of zeros: no true positives, no tokens, and
 * a denominator of every real-regression scenario. That reads as a tool which looked at everything
 * and caught nothing, which is a claim about a tool nobody ran — and it goes straight into the
 * baseline that any "before" number is later read from.
 *
 * The denominator was worse than the zeros. `measuredRealRegressions` excluded a scenario by testing
 * `verdict !== 'NOT MEASURED'`, and an absent tool has no cell at all, so its verdict is `undefined`
 * — which passes that test. The tools that never ran were credited with the whole grid INCLUDING the
 * scenario deliberately skipped for everyone who did run, giving them a denominator one larger than
 * the tools that were actually measured.
 *
 * Both halves are the same rule stated twice: a cell that does not exist is not a measurement.
 */

/**
 * The declared columns, in declared order, filtered to those that produced at least one row.
 *
 * Order comes from the caller's list rather than from the rows, so the report reads the same however
 * the run happened to interleave.
 */
export function toolsMeasured(rows, allTools) {
  return allTools.filter((tool) => rows.some((row) => row?.tool === tool));
}

/**
 * Real-regression scenarios (`expected_detect`) that this tool actually measured.
 *
 * A NOT MEASURED cell is excluded rather than counted as a miss — a scenario that could not be
 * injected is not a failure to detect it. An ABSENT cell is excluded for the stronger reason that
 * there is nothing there to have measured.
 */
export function measuredRealRegressions(perScenario, tool) {
  return Object.values(perScenario ?? {}).filter((s) => {
    if (true !== s?.expected_detect) return false;
    const cell = s.by_tool?.[tool];
    return undefined !== cell && 'NOT MEASURED' !== cell.verdict;
  }).length;
}
