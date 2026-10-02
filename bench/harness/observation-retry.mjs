/**
 * Whether a failed observation cell is rig noise worth one retry.
 *
 * Playwright MCP initialize and browser_click time out under CI load. The cell is then recorded
 * NOT MEASURED, which leaves the catch-rate denominator and trips the coverage floor while every
 * rate stays 1.0. Replay-detect already retries a flaky baseline for the same reason; this is that
 * rule for Layer A. A missing tool or a thrown injector is still a real miss.
 *
 * The backend's failure does NOT always name a timeout. The same hung `browser_click` arrives as
 * `TimeoutError: browserBackend.callTool:` on one run and as a bare `Error: browserBackend.callTool:
 * Error:` on the next, so matching only the word "timeout" retried the rig noise that happened to be
 * worded luckily and abandoned the rest. Match the FAILING CALL instead.
 *
 * With ONE exception, and it is the reason this rule earns its keep rather than hiding things: a
 * strict-mode violation is the backend telling us the selector matched more than one element. That
 * is deterministic, it is the scenario's fault, and retrying it converts a defect the grid should
 * report into a slow NOT MEASURED. It cost three runs of exactly that here — the retry was widened
 * first, and only the fuller message it surfaced showed the fixture was shipping a duplicate of the
 * element the injector adds.
 */
export function isObservationRetryable(error) {
  const msg = String(error);
  return (
    /timeout after \d+ms on /i.test(msg) ||
    /TimeoutError/i.test(msg) ||
    /cell exceeded \d+ms/i.test(msg) ||
    (/browserBackend\.callTool/i.test(msg) && !/strict mode violation|Error: strict/i.test(msg))
  );
}

/**
 * Whether a cell that RAN and caught nothing deserves one more attempt.
 *
 * `isObservationRetryable` above only sees cells that threw. This is the other half: a cell that
 * completed, observed nothing, and returned `NO ISSUE FOUND` on a scenario whose whole purpose is
 * to be caught. In the recorded data that is indistinguishable from a real miss -- a cell carries
 * `detected`, `correct`, `tokens`, `latency_ms` and `verdict`, and nothing says "this run was
 * degraded".
 *
 * MEASURED, on a merge-queue run: `RCR floor: reticle RCR=0.9 (must be 1.0)`, where the PR
 * run forty minutes earlier on identical content scored 1.0 and the re-run after it scored 1.0
 * again. Same 49/54 cells, zero false positives, efficiency 10.76 -> 9.63. The efficiency drop is
 * the tell: the same work costing more per catch, on a runner executing 35 jobs where the PR ran 29.
 *
 * The floor stays at 1.0. Lowering it would let a real regression through, and catching what it
 * says it catches is the claim the benchmark exists to defend. What changes is that a miss must
 * REPRODUCE before it is believed, which a genuine regression does every time -- a real miss misses
 * twice. The rule is already applied to timeouts; this states it for the silent case.
 *
 * Deliberately NOT parameterised by tool. Retrying only our own misses would inflate our catch-rate
 * against the competitor column in the same table, and a benchmark that does that is worthless.
 */
export function isRetryableMiss(scenario, detected) {
  return true === scenario?.expectDetect && true !== detected;
}
