import type { RunId, RunVerdict } from './verification-run.js';

/**
 * Correcting a verdict when the truth arrives after the window closed.
 *
 * Two of the reasons a verdict can carry mean, in plain words, "the truth has not arrived yet": a
 * write the server accepted for later processing, and a window that closed while something was
 * still in flight. Both were final the moment they were made. A write that is accepted and then
 * succeeds was recorded as `unknown` forever, and nothing anywhere could say otherwise.
 *
 * That is an unsoundness rather than a missing convenience. A judgement made over a bounded stretch
 * of time, presented as final, is a claim the evidence does not support -- the evidence supports
 * "this is what it looked like by the time we stopped watching".
 *
 * **A revision never edits the verdict it replaces.** It is a new verdict that cites the old one.
 * Both are kept. Anybody reading them can see that the first answer was given, when it changed, and
 * why -- and "we always knew" stops being expressible.
 *
 * Nothing calls this yet. The mechanism exists so that a later adjudication over late evidence has
 * somewhere to put its answer; wiring it into a live adjudication changes what verdicts a run
 * produces, which is a measurable change and belongs with its measurement.
 */

/** How a verdict is named, so another can point at it. */
export function citeVerdict(runId: RunId, checkId: string): string {
  return `${runId}#${checkId}`;
}

/** Is this verdict a correction of that one? */
export function isRevisionOf(verdict: RunVerdict, runId: RunId, checkId: string): boolean {
  return verdict.supersedes === citeVerdict(runId, checkId);
}

interface Revision {
  /** The verdict being corrected. Left untouched. */
  readonly earlier: RunVerdict;
  /** The run the earlier verdict belongs to. */
  readonly earlierRunId: RunId;
  /** What the answer is now that the rest of the evidence has arrived. */
  readonly status: RunVerdict['status'];
  /** Why it changed, in the words of whoever made the new judgement. */
  readonly reasons: readonly string[];
}

/**
 * A new verdict that corrects an earlier one.
 *
 * Returns a fresh object; the earlier verdict is not modified. It carries the new reasons rather
 * than appending to the old ones -- the old ones described what was known at the time, and they are
 * still there, on the verdict this one cites.
 */
export function reviseVerdict(revision: Revision): RunVerdict {
  const { earlier, earlierRunId, status, reasons } = revision;
  const checkId = earlier.checkId;
  if (checkId === undefined) {
    // A citation nobody can resolve is not a citation. Refusing here is better than emitting a
    // correction that points at something unidentifiable.
    throw new Error(
      'cannot revise a verdict that never said which check it was about: nothing could resolve ' +
        'the citation, so the correction would claim to replace something nobody can find',
    );
  }
  return {
    status,
    reasons: [...reasons],
    confidence: earlier.confidence,
    blockingRisks: earlier.blockingRisks,
    checkId,
    supersedes: citeVerdict(earlierRunId, checkId),
  };
}
