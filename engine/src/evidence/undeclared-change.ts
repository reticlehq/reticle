import { NO_EDITS_OBSERVED } from '@reticlehq/core';

/**
 * Is this verdict being drawn over code nobody said anything about?
 *
 * Declaring intent is opt-in, and nothing has ever noticed that a change landed and nobody said what
 * it was supposed to make true. That is the moment it matters: a change with no declared intent can
 * only be verified against itself, which is the definition of a false green.
 *
 * ## Why this fires on EVERY verdict, not once per change
 *
 * The house rule is that a gap nobody hit is a backlog, and a backlog reported as a finding is how
 * an agent learns to stop reading findings. This clears that bar on the same test every other
 * instrumentation gap clears it on: **did the absence make THIS verdict weaker?** An unwatched store
 * weakens every state assertion made over it, not merely the first, so it is reported on every one.
 * An undeclared change is the same shape — while nothing says what the edit was for, each verdict
 * drawn after it is checked against nothing but itself, and that is true of the fifth one exactly as
 * it was of the first. Reporting it once and then falling silent would leave four verdicts carrying
 * a weakness they no longer disclose, which is the failure mode this whole surface exists to prevent.
 *
 * It is also not a backlog, because it is not a survey of the project: it is answered from what this
 * session observed (an epoch that moved) about the verdict being returned right now, and it is
 * closed by one call the agent can make immediately. A finding that stays open only because the
 * agent has not made that call is a finding about the current verdict, not a chore.
 *
 * ## The silences, and why each one is required
 *
 *  - **An edit was actually OBSERVED.** The epoch degrades to `NO_EDITS_OBSERVED` outside Vite, and
 *    that means "no edits observed", never "no edits happened" — a finding built on an absence
 *    Reticle cannot see would be a fabrication.
 *  - **The ledger holds nothing undischarged.** An open intent IS the declaration; silence is the
 *    correct response to it, and declaring one is what turns this off from the next verdict on.
 *
 * ## Why "covers the work" is answered as "anything open at all"
 *
 * The tempting answer is to match the intent's `surface` against the files that changed. Reticle
 * cannot do that honestly: it observes that an epoch advanced, not WHAT advanced — the hot-update
 * channel reports a counter, not a diff — so any file-level matching would be inference dressed as a
 * fact, and it would fire on an agent that had declared its intent perfectly well. Over-reporting on
 * a correct agent is the direction of error that trains it to stop reading findings.
 *
 * So the question asked is the coarse one, and it is asked honestly: has the agent declared anything
 * that is still outstanding? If it has, it is working to a stated purpose and this stays quiet.
 */

/**
 * `openIntents` is a thunk rather than a list because reading the ledger touches disk, and the epoch
 * check answers without it for every page that never reported a hot update — which is most of them.
 * Once an edit HAS been observed the read happens per verdict, and that is the intended cost: the
 * ledger is the only thing that can end it, so it has to be re-asked each time.
 */
export async function isChangeUndeclared(
  /** The epoch the session is under now. Undefined when the page never stamped one. */
  currentEpoch: number | undefined,
  openIntents: () => Promise<readonly unknown[]>,
): Promise<boolean> {
  if (undefined === currentEpoch || NO_EDITS_OBSERVED === currentEpoch) return false;
  return 0 === (await openIntents()).length;
}
