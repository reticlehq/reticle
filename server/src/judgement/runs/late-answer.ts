import { Verified, type RunCheck } from '@reticlehq/core';

/**
 * A verdict that was open, and a later one that answers it.
 *
 * The specification says a verdict may be superseded when late evidence lands, and until now
 * nothing in this codebase ever produced one. The mechanism existed in core, the fields reached
 * the exported artifact, and no code path called any of it -- which is a rule written down and
 * not followed, the shape this repository has already been caught in twice.
 *
 * ── WHAT COUNTS AS AN ANSWER, AND WHAT DOES NOT ─────────────────────────────────────────────────
 *
 * Only a verdict that was open BECAUSE THE OUTCOME HAD NOT ARRIVED can be answered later. That is
 * the whole reason the journal now records a reason: `unknown` covers both "the write was
 * accepted and has not finished" and "the capture was dirty so I could not see", and only the
 * first is a question that waiting can settle. Superseding the second would be claiming that a
 * later, unrelated observation resolved a blind spot -- inventing evidence about evidence.
 *
 * The later verdict must be about **the same claim**. Matching on anything looser -- the same
 * action, the same window, the nearest verdict in time -- would attach an answer to a question
 * nobody asked, and it would do it silently, because both records look perfectly well-formed.
 *
 * And it must actually DECIDE. A second `unknown` is not an answer; it is the same question
 * asked again, and recording it as a correction would turn a run into a chain of verdicts that
 * never resolves while looking like progress.
 */

/** The reason a verdict stays open because the truth has not arrived yet. */
export const OUTCOME_PENDING = 'outcome_pending';

/** A verdict, as the fold sees it: a claim, an answer, and why. */
export interface Answered {
  readonly claim: string;
  readonly verified: Verified;
  readonly reason?: string | undefined;
}

/** Did this verdict leave a question open that a later observation could settle? */
export function isAwaitingOutcome(verdict: Answered): boolean {
  return Verified.UNKNOWN === verdict.verified && OUTCOME_PENDING === verdict.reason;
}

/** Does this verdict actually decide something? A second `unknown` answers nothing. */
export function decides(verdict: Answered): boolean {
  return Verified.YES === verdict.verified || Verified.NO === verdict.verified;
}

/**
 * For each check, the index of the earlier check it corrects, if any.
 *
 * Returned as indices rather than as rewritten checks so the caller keeps both records. A
 * correction never edits the verdict it replaces: both stand, and a reader can see that the
 * first answer was given, when it changed, and why. Rewriting in place would erase the fact that
 * the question was ever open, and "we always knew" is the shape of the problem this whole
 * system exists to prevent.
 *
 * The FIRST open verdict for a claim is the one corrected. A claim asked three times -- pending,
 * pending, then answered -- has one question and one answer, not two corrections; taking the
 * latest would silently drop the middle record from the chain a reader follows back.
 */
export function correctionsAmong(checks: readonly Answered[]): ReadonlyMap<number, number> {
  const openFor = new Map<string, number>();
  const corrections = new Map<number, number>();
  for (const [index, check] of checks.entries()) {
    if (isAwaitingOutcome(check)) {
      if (!openFor.has(check.claim)) openFor.set(check.claim, index);
      continue;
    }
    if (!decides(check)) continue;
    const earlier = openFor.get(check.claim);
    if (earlier !== undefined) {
      corrections.set(index, earlier);
      openFor.delete(check.claim);
    }
  }
  return corrections;
}

/** The citation a correction carries, as the protocol spells it. */
export function citeCheck(runId: string, index: number): string {
  return `${runId}#c${String(index + 1)}`;
}

/** Stamp the checks that correct an earlier one, leaving the earlier ones untouched. */
export function withCorrections(runId: string, checks: readonly RunCheck[]): RunCheck[] {
  const corrections = correctionsAmong(
    checks.map((c) => ({ claim: c.predicate, verified: c.status, reason: c.reason })),
  );
  return checks.map((check, index) => {
    const earlier = corrections.get(index);
    return earlier === undefined
      ? { ...check, checkId: `c${String(index + 1)}` }
      : { ...check, checkId: `c${String(index + 1)}`, supersedes: citeCheck(runId, earlier) };
  });
}
