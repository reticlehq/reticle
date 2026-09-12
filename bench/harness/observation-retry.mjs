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
