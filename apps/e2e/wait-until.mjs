/**
 * Wait for a CONDITION, not for a number of milliseconds to pass.
 *
 * This repo already fixed this once, in one file: `telemetry-events-test` slept a fixed 700ms
 * fifteen times before asserting an event had landed, which is a statement about the machine rather
 * than about the product — the shape CLAUDE.md calls a bug, and the one that "fails only under
 * parallel load, i.e. only in CI". The commit that fixed it (66dbb59a) said outright that it was
 * "not swept across the other specs". Twenty-two percent of the battery's wall clock was still
 * unconditional `sleep` when somebody measured.
 *
 * This is that fix, generalised, and it is deliberately tiny:
 *
 *   - It NEVER throws and never asserts a duration. A probe that blows up (the session dropped, the
 *     tool refused) is a not-yet, not a failure — the poll swallows it and tries again.
 *   - At the cap it RETURNS the last value it saw rather than failing. The check on the next line is
 *     what reports "the event never arrived", with its own detail string, exactly as it did when the
 *     line above it was a sleep. A helper that threw here would replace a readable check with a
 *     stack trace from a utility file.
 *   - The cap is generous on purpose. Its job is to stop a hang, not to be the assertion: a spec that
 *     passes at 200ms on a laptop and needs 9s on a loaded runner must still pass.
 *
 * Not for a sleep that is SIMULATING something — user think-time, an idle window a daemon is meant
 * to shut down inside, the interval a heartbeat is meant to miss. There the elapsed time IS the
 * input, and polling it away would delete the test.
 */

/** Generous by design — see above. Nothing here is measuring how long anything took. */
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_STEP_MS = 50;

/**
 * Poll `probe` until it returns something truthy, then return that value.
 *
 * Returns the last value seen (commonly `undefined`) if the cap is reached, so the caller's own
 * assertion is still the thing that reports the failure.
 */
export async function waitUntil(probe, { timeoutMs = DEFAULT_TIMEOUT_MS, stepMs = DEFAULT_STEP_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try {
      last = await probe();
    } catch {
      last = undefined;
    }
    if (last !== undefined && last !== null && last !== false) return last;
    if (Date.now() >= deadline) return last;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}
