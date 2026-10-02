/**
 * Which round of source edits an observation belongs to.
 *
 * `document-identity` scopes evidence to the DOCUMENT it was recorded under, because a navigation
 * throws the page away and takes the truth of everything observed under it with it. This is the same
 * problem for EDITS, and the document id cannot see it: a hot update swaps modules and re-renders
 * inside the same document, so the id never moves. The agent that Reticle is increasingly driven by
 * edits source and re-verifies in a loop — so it routinely reads observations describing code it has
 * already replaced, and refs minted against nodes the framework has already thrown away.
 *
 * An epoch is a counter that advances once per applied hot update. It is NOT a clock and NOT an
 * identity: only the ordering matters, and only within one document (a navigation mints a new
 * document, and a new SDK instance starts the count again — which is correct, because the document
 * scoping already excludes everything from before it).
 *
 * This lives in `core` because it crosses the wire, and every wire value is defined here.
 */

/**
 * The epoch of a page in which no hot update has been observed.
 *
 * ABSENCE OF EVIDENCE, NOT EVIDENCE OF ABSENCE. Most pages Reticle instruments have no channel that
 * can report a hot update at all — Next, Electron, Tauri, a plain script tag — and a Vite page has
 * none until the first update arrives. So this value means "no edits observed", never "no edits
 * happened", and nothing may be excluded or accused on the strength of it.
 */
export const NO_EDITS_OBSERVED = 0;

/**
 * Was this evidence recorded under the edit epoch currently in force?
 *
 * **Unstamped evidence counts as current**, following `isSameDocument` exactly rather than inventing
 * a stricter rule beside it. An SDK older than this field stamps nothing, and so does a perfectly
 * current SDK in a page with no hot-update channel. Reading either as foreign would make those
 * installations silently stop reporting real contradictions, and a verification tool that quietly
 * finds nothing is worse than one that occasionally over-reports.
 */
export function isSameEditEpoch(
  evidenceEpoch: number | undefined,
  currentEpoch: number | undefined,
): boolean {
  if (undefined === evidenceEpoch || undefined === currentEpoch) return true;
  return evidenceEpoch === currentEpoch;
}
