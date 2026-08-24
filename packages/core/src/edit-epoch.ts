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
 * While no edit has been observed (`current` is undefined or `NO_EDITS_OBSERVED`), unstamped
 * evidence counts as current — same as `isSameDocument`, and required for older SDKs and pages with
 * no hot-update channel.
 *
 * Once an edit HAS been observed (`current > 0`), unstamped evidence is foreign. Omitting `0` on
 * the wire used to leave pre-edit events looking current forever after the first hot update; that
 * made `EVIDENCE_PREDATES_EDIT` unreachable on the common path.
 */
export function isSameEditEpoch(
  evidenceEpoch: number | undefined,
  currentEpoch: number | undefined,
): boolean {
  if (undefined === currentEpoch || currentEpoch === NO_EDITS_OBSERVED) {
    return true;
  }
  if (undefined === evidenceEpoch) return false;
  return evidenceEpoch === currentEpoch;
}
