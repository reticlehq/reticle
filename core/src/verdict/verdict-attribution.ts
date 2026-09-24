import { VerifiedReason } from './verified-constants.js';

/**
 * WHOSE problem an unproved verdict is.
 *
 * `verified` says whether the claim held. `verifiedReason` says which clause decided it. Neither
 * says who should act, and for `unknown` that is the only question the reader has. Three of the
 * reasons below arrive as the same word today - "the backend answered 202 and has not finished",
 * "the page SDK and the daemon are on different contracts", and "the capture was truncated" - and
 * they need three opposite next moves: wait, fix Reticle's setup, look again with better coverage.
 *
 * Four owners, because four are what the evidence can actually distinguish. A fifth would be a word
 * nobody could act on differently, and the whole point of this field is that each value implies a
 * different move.
 *
 * NOT `BugAttribution`, and the two must not be merged. That one answers "we found a defect — whose
 * defect is it?" over app/request/reticle/unclassified. This one answers "we could NOT decide — who
 * can act?", which is a question about the absence of a verdict rather than about a finding, and it
 * has to distinguish a thing that resolves by WAITING (`environment`) from a thing that resolves by
 * LOOKING AGAIN (`could-not-see`). `BugAttribution` has no member for either, because a bug is never
 * either of them. Named apart on purpose: one vocabulary stretched over two questions is how both
 * end up wrong.
 */
export const VerdictAttribution = {
  /** The app under test is wrong. The assertion failed, or two channels disagree about it. */
  CODE: 'code',
  /**
   * Nothing is wrong yet: something outside the app's own code has not finished or never settled.
   *
   * The one class that resolves by WAITING, which is why it must not read as a defect. An agent that
   * treats "the server is still working" as a failure re-drives a system that was fine.
   */
  ENVIRONMENT: 'environment',
  /**
   * Reticle, or how it was driven. Our own pieces disagreeing, a window we closed too early, a claim
   * the caller declared that could never have proved anything.
   *
   * Named honestly on purpose. A tool that reports its own failures as the app's is the confident
   * wrong answer this project exists to remove, and it is the class a user can most easily fix once
   * they are told it is theirs.
   */
  HARNESS: 'harness',
  /**
   * The evidence needed was missing. Not a failure of the app, and not a failure of the run - a gap
   * in what was observable, which is the one that says LOOK AGAIN rather than GO FIX SOMETHING.
   */
  COULD_NOT_SEE: 'could-not-see',
  /** The claim was proved. There is no owner to name, and the field is omitted rather than carrying this. */
  NONE: 'none',
} as const;
export type VerdictAttribution = (typeof VerdictAttribution)[keyof typeof VerdictAttribution];

/**
 * Every reason the verdict ladder can produce, and whose problem it is.
 *
 * Total over `VerifiedReason` by design, and guarded as exhaustive by equality: a new clause cannot
 * ship without somebody deciding who owns it. That is a thirty-second decision while the clause is
 * being written, and an archaeology problem a year later - the same argument the `.reticle`
 * partition makes, for the same reason.
 *
 * Derived from the reason rather than decided separately. A second decision is a second thing that
 * can disagree with the first, and the reason already carries everything this needs.
 */
const OWNER: Readonly<Record<VerifiedReason, VerdictAttribution>> = {
  // The app was actually disproved — the only two that are.
  [VerifiedReason.ASSERTION_FAILED]: VerdictAttribution.CODE,
  [VerifiedReason.CONTRADICTED]: VerdictAttribution.CODE,

  // Still working. Waiting is the move.
  [VerifiedReason.OUTCOME_PENDING]: VerdictAttribution.ENVIRONMENT,
  [VerifiedReason.UNSETTLED]: VerdictAttribution.ENVIRONMENT,

  // Ours, or the caller's — either way not the app's.
  [VerifiedReason.VERSION_SKEW]: VerdictAttribution.HARNESS,
  [VerifiedReason.WINDOW_CLOSED_EARLY]: VerdictAttribution.HARNESS,
  [VerifiedReason.NOTHING_DECLARED]: VerdictAttribution.HARNESS,
  [VerifiedReason.VACUOUS_GRADE]: VerdictAttribution.HARNESS,
  [VerifiedReason.ALREADY_TRUE]: VerdictAttribution.HARNESS,

  // The evidence was not there to read.
  [VerifiedReason.CAPABILITY_ABSENT]: VerdictAttribution.COULD_NOT_SEE,
  [VerifiedReason.OBSERVATION_LOST]: VerdictAttribution.COULD_NOT_SEE,
  [VerifiedReason.UNCLEAN_CAPTURE]: VerdictAttribution.COULD_NOT_SEE,
  [VerifiedReason.EVIDENCE_INCOMPLETE]: VerdictAttribution.COULD_NOT_SEE,
  [VerifiedReason.ABSENCE_BLIND_SPOT]: VerdictAttribution.COULD_NOT_SEE,
  [VerifiedReason.OUTCOME_UNREAD]: VerdictAttribution.COULD_NOT_SEE,
  [VerifiedReason.INCONCLUSIVE]: VerdictAttribution.COULD_NOT_SEE,

  [VerifiedReason.PROVED]: VerdictAttribution.NONE,
};

/** Who owns this verdict reason, or `undefined` for a reason nobody has classified. */
export function verdictAttributionOf(reason: VerifiedReason): VerdictAttribution | undefined {
  return OWNER[reason];
}
