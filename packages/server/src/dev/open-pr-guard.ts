/**
 * The open PR list lies in two directions, and both cost contributor evenings.
 *
 * `stale-issue-guard.ts` catches one lie — an issue left open after a commit said it was closed.
 * These are its mirror image, about the PR list, which nothing reads today.
 *
 * 1. **A PR whose work is already on `main`.** Ten were closed by hand on 2026-09-08, some open for
 *    over two weeks, each already merged under a different commit. #645's own merge commit says
 *    "Merge PR #645" and GitHub still never closed it. The author never learns their work shipped,
 *    a reviewer re-reviews it, and the backlog reads deeper than it is.
 * 2. **An issue whose PR nobody can see.** GitHub surfaces "a PR references this" nowhere a reader
 *    notices, and contributors' titles rarely carry the issue number, so an issue-number grep over
 *    the PR list finds nothing. 19 of 53 open issues had an unannounced open PR; four duplications
 *    happened in one day, two of them by the maintainer.
 *
 * Both answers are HINTS. A title match cannot prove a PR landed, only that something carrying its
 * subject did — so the report asks the reader to verify with `git merge-base` rather than telling
 * anyone to close a contributor's work on the strength of a substring. A guard that overstates gets
 * switched off, and then catches nothing at all.
 */

/** The fields of an open PR these checks read. A superset arrives from `gh`; this is what is used. */
export interface OpenPr {
  number: number;
  title: string;
  body: string;
}

/** An open issue and every open PR that mentions it. */
export interface UnannouncedClaim {
  issue: number;
  prs: number[];
}

/**
 * Shorter than this, a title is not evidence.
 *
 * A one- or two-word subject substring-matches half of any history, and the first false positive is
 * what teaches a reader to ignore the check. Long enough that a real conventional-commit subject
 * ("fix(server): x") clears it comfortably.
 */
const MIN_TITLE_CHARS = 20;

/**
 * Open PRs whose title already appears in a commit subject on `main`.
 *
 * Substring rather than equality, because a squash merge appends ` (#NNN)` and a manual merge
 * prepends `Merge PR #NNN: ` — both were seen in the ten. Matching the PR's full title inside the
 * subject covers both without matching on a shared conventional-commit prefix, which would report
 * the entire backlog.
 */
export function landedPullRequests(
  prs: readonly OpenPr[],
  mainSubjects: readonly string[],
): number[] {
  return prs
    .filter((pr) => {
      const title = pr.title.trim();
      if (title.length < MIN_TITLE_CHARS) return false;
      return mainSubjects.some((subject) => subject.includes(title));
    })
    .map((pr) => pr.number);
}

/** Any `#123`, closing verb or not. */
const ANY_ISSUE_REF = /#(\d+)/g;

/**
 * Above this many references, a PR is DESCRIBING issues rather than claiming them.
 *
 * This guard cried wolf on its own first live run: the PR that introduced it lists eighteen
 * issue→PR pairs in its body as evidence that the problem is real, and was then reported as a
 * claimant on all eighteen. Every issue read as having two PRs against it and the output became
 * noise on the day it shipped.
 *
 * Five, not three: #429 legitimately closes #428, #430 and #433, and a cap that caught honest
 * multi-issue work would be the same failure in the other direction. Counted BEFORE filtering to
 * open issues, so a long listing of mixed state cannot slip under the cap by being mostly closed.
 */
const MAX_CLAIMED_ISSUES = 5;

/**
 * Open issues that an open PR references, so the claim can be made visible where people read it.
 *
 * Deliberately counts a BARE reference, which is the opposite call from `closedRefsIn`. There the
 * question is what a commit claims to have closed, and over-counting would cry wolf. Here it is
 * whether a contributor about to start would want to know this PR exists — and for that, "related
 * to #5" is exactly as informative as "closes #5".
 */
export function issuesWithOpenPr(
  prs: readonly OpenPr[],
  openIssues: readonly number[],
): UnannouncedClaim[] {
  const open = new Set(openIssues);
  const byIssue = new Map<number, number[]>();
  for (const pr of prs) {
    const allRefs = new Set<number>();
    for (const match of `${pr.title}\n${pr.body}`.matchAll(ANY_ISSUE_REF)) {
      const raw = match[1];
      if (raw === undefined) continue;
      const parsed = Number.parseInt(raw, 10);
      // A PR quoting its own number is noise, not a claim on an issue.
      if (Number.isFinite(parsed) && parsed !== pr.number) allRefs.add(parsed);
    }
    // Counted over EVERY reference, before narrowing to open issues — see MAX_CLAIMED_ISSUES.
    if (allRefs.size > MAX_CLAIMED_ISSUES) continue;
    const referenced = [...allRefs].filter((number) => open.has(number));
    for (const issue of referenced) {
      byIssue.set(issue, [...(byIssue.get(issue) ?? []), pr.number]);
    }
  }
  return [...byIssue.entries()]
    .sort(([a], [b]) => a - b)
    .map(([issue, list]) => ({ issue, prs: [...list].sort((a, b) => a - b) }));
}

/** Empty string when there is nothing to say, so a clean run prints nothing at all. */
export function landedPullRequestReport(landed: readonly number[]): string {
  if (0 === landed.length) return '';
  const list = landed.map((n) => `#${String(n)}`).join(', ');
  return (
    `${list} may already be on \`main\`: a commit subject there contains the PR's own title. ` +
    `VERIFY before acting — a title match is evidence, not proof. Compare the file lists, and run ` +
    `\`git merge-base --is-ancestor <commit> origin/main\`. If it did land, close the PR saying so ` +
    `and crediting the author: ten were found open this way in one day, one of them merged under a ` +
    `commit literally titled "Merge PR #645".`
  );
}

/** Empty string when there is nothing to say. */
export function unannouncedClaimReport(claims: readonly UnannouncedClaim[]): string {
  if (0 === claims.length) return '';
  const lines = claims.map(
    ({ issue, prs }) => `  #${String(issue)} <- ${prs.map((n) => `#${String(n)}`).join(', ')}`,
  );
  return (
    `These open issues have an open PR against them, and GitHub shows that nowhere a reader ` +
    `notices:\n${lines.join('\n')}\n` +
    `Post the claim on each issue. Four contributors duplicated each other's work in one day ` +
    `because the issue said nothing about the PR that already existed.`
  );
}
