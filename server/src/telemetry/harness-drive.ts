/**
 * Whether the tool call running right now belongs to one of OUR drives.
 *
 * `reticle_verify { action: "explore" }` hands the app to a model inside the daemon, which drives
 * through the same dispatch chokepoint every agent uses. That is the right design — the inner
 * `act_and_wait` and `assert` calls are real verifications and must be counted — but it left every
 * verdict a drive produced indistinguishable from one the user's own agent earned, under the same
 * session and the same `actor: agent`. So "did this install ever verify anything by itself" had no
 * answer, and any per-session rate read high by however much we drove.
 *
 * Module state, one flag, set for the span of the drive. The same one-hop pattern `tool-refused.ts`
 * already uses for its pending reason, and for the same reason: the fact is produced in one place
 * and needed in another, with a chokepoint in between that has no business taking an extra argument
 * for a metric.
 *
 * A COUNTER rather than a boolean, so a drive nested inside a drive cannot clear the flag on its way
 * out and leave the outer one unmarked.
 */
let depth = 0;

/** Run `drive` with every verdict underneath it attributed to the harness. */
export async function withHarnessDrive<T>(drive: () => Promise<T>): Promise<T> {
  depth += 1;
  try {
    return await drive();
  } finally {
    // In a `finally` because a drive that THREW still drove: leaving the flag raised would attribute
    // the user's own next verdict to a harness that is no longer running.
    depth -= 1;
  }
}

/** True while a harness drive is in progress. */
export function harnessDriving(): boolean {
  return depth > 0;
}

/** Tests only — a leaked span would mis-attribute every verdict after it. */
export function resetHarnessDrive(): void {
  depth = 0;
}
