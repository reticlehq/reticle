/**
 * Which failing flows can support a verdict ABOUT THE CHANGED FILES.
 *
 * `affectedSavedFlows` deliberately re-runs any flow whose covered sources it cannot determine —
 * over-running beats silently skipping — and reports those names in `unknownProvenance`. The verdict
 * then ignored that and answered NO whenever anything failed, producing the observed
 *
 *   verified: "no", because "1 of 1 covering flows failed
 *                            (1 of them re-run only because Reticle cannot tell which sources they cover)"
 *
 * — a negative claim about `src/App.tsx` whose own explanation admits the evidence is not tied to it.
 *
 * This tool already refuses the mirror-image error: an uncovered change is UNKNOWN, never a green,
 * because "nothing ran, so nothing was proved". A red nothing earned is the same mistake reversed.
 */

/** Failing flows minus the ones that only ran because their provenance is unknown. */
export function attributedFailures(
  failingFlows: readonly string[],
  unknownProvenance: readonly string[],
): string[] {
  const unattributable = new Set(unknownProvenance);
  return failingFlows.filter((flow) => !unattributable.has(flow));
}
