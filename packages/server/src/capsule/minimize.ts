/**
 * Bug-capsule minimization — first cut: prefix-trim. A recorded flow that fails is often mostly setup;
 * the capsule should be the SMALLEST flow that still reproduces the failure, so a regression flow stays
 * fast and legible. Prefix-trim drops leading steps while the failure persists — the cheap, deterministic
 * v1 (delta-debugging over arbitrary subsets is a later refinement). The `stillFails` predicate is
 * injected (a real replay), so this stays pure and unit-testable.
 */

/**
 * Return the shortest trailing sub-flow that still fails, by removing leading steps one at a time while
 * `stillFails` holds. Never trims below one step. Deterministic given a deterministic predicate.
 */
export async function prefixTrim<T>(
  steps: readonly T[],
  stillFails: (candidate: readonly T[]) => Promise<boolean>,
): Promise<T[]> {
  let kept = [...steps];
  while (kept.length > 1) {
    const trimmed = kept.slice(1);
    if (await stillFails(trimmed)) kept = trimmed;
    else break;
  }
  return kept;
}
