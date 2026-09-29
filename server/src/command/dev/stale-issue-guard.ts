/**
 * An issue we have already fixed must not still read as available work.
 *
 * A commit saying it closes an issue is a claim that the issue is done. If that issue is still open
 * and unlabelled afterwards, the tracker is lying to whoever reads it next — and the person it lies
 * to is by definition someone looking for something to work on. Remembering is not a mechanism; this
 * is the smallest one that works.
 *
 * ## Why `fixed-pending-release` is an accepted answer
 *
 * Work that is already ON the release branch is legitimately still open; the issue closes when the
 * version ships. The label is that fact. It is not a fact about an open pull request. Applying it
 * there is what told contributors a fix had shipped when the pull request was still unmerged.
 *
 * Pure. The git log and the GitHub lookup belong to the caller, which is what makes every branch
 * below testable without a network or a repo.
 */

export interface IssueState {
  number: number;
  state: 'open' | 'closed';
  labels: readonly string[];
}

/** The label that means "fixed, waiting for a release" — an honest reason to still be open. */
const PENDING_RELEASE_LABEL = 'fixed-pending-release';

/**
 * Issue numbers a commit message CLAIMS to have closed.
 *
 * Only the closing verbs GitHub itself acts on. A bare `#447`, a `Refs #447` or a `see #447` is how
 * a change points at context it did not close — the exact habit we want to encourage — so counting
 * those would make the guard cry wolf on good behaviour, and a check that cries wolf is one people
 * learn to skip.
 */
const CLOSING_REF = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi;

export function closedRefsIn(commitMessage: string): number[] {
  const seen = new Set<number>();
  for (const match of commitMessage.matchAll(CLOSING_REF)) {
    const raw = match[1];
    if (raw === undefined) continue;
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed)) seen.add(parsed);
  }
  return [...seen];
}

/**
 * Of the issues these commits claimed to close, the ones still reading as available work.
 *
 * An issue that could not be looked up is deliberately silent rather than failing. A rate limit, a
 * transferred issue or a deleted one would otherwise turn this red for a reason unrelated to what it
 * guards, and a guard that goes red for unrelated reasons gets disabled — which costs more than the
 * defect it was catching.
 */
export function staleIssues(claimed: readonly number[], issues: readonly IssueState[]): number[] {
  const byNumber = new Map(issues.map((issue) => [issue.number, issue]));
  return claimed.filter((number) => {
    const issue = byNumber.get(number);
    if (issue === undefined) return false;
    if ('closed' === issue.state) return false;
    return !issue.labels.includes(PENDING_RELEASE_LABEL);
  });
}

/** The message the guard prints. Held here so the check and its tests cannot describe it differently. */
export function staleIssueReport(stale: readonly number[]): string {
  const list = stale.map((n) => `#${String(n)}`).join(', ');
  const pronoun = 1 === stale.length ? 'it' : 'them';
  return (
    `${list} ${1 === stale.length ? 'is' : 'are'} still OPEN, and a commit on this branch says it ` +
    `closes ${pronoun}. Anyone browsing the tracker reads that as work nobody has started. Close ` +
    `${pronoun} when this merges. Do not apply \`${PENDING_RELEASE_LABEL}\` from an open pull ` +
    `request: that label means the fix is already on the release branch and waiting for the version ` +
    `to ship. Applying it earlier is what sent contributors away from work that was not merged.`
  );
}
