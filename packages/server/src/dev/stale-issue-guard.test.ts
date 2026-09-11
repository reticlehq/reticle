import { describe, expect, it } from 'vitest';
import { closedRefsIn, staleIssues, type IssueState } from './stale-issue-guard.js';

/**
 * An issue we have already fixed must not still read as available work.
 *
 * Three contributor PRs died on arrival in one week for exactly this: #373 was filed and fixed by us
 * three hours later, then left open for three more days, and somebody spent an evening on it. #398
 * shipped and stayed open; a second contributor rebuilt it. `GITHUB.md` documents the same failure
 * costing three contributors before that, so this is the third occurrence of a defect we have
 * already written down and asked ourselves to remember.
 *
 * Remembering is not a mechanism. This is: a commit that says it closes an issue is a claim that the
 * issue is done, and if the issue is still open and unlabelled after that claim, the tracker is
 * lying to whoever reads it next.
 */

const OPEN = (number: number, labels: string[] = []): IssueState => ({
  number,
  state: 'open',
  labels,
});

describe('closedRefsIn', () => {
  it.each(['Closes #443', 'closes #443', 'Fixes #443', 'FIXED #443', 'Resolves #443'])(
    'reads %s',
    (line) => {
      expect(closedRefsIn(line)).toEqual([443]);
    },
  );

  it('reads several across a whole commit body', () => {
    const body = 'feat: a thing\n\nCloses #1\nbody text\nFixes #22\n\nCo-Authored-By: someone';
    expect(closedRefsIn(body).sort((a, b) => a - b)).toEqual([1, 22]);
  });

  it('does not treat a bare mention as a claim that it is done', () => {
    // "Refs #447" and "see #447" are how a PR points at context it did NOT close. Treating those as
    // closing claims would make the guard cry wolf on the one habit we want to encourage.
    expect(closedRefsIn('Refs #447 — the second half')).toEqual([]);
    expect(closedRefsIn('see #447 for background')).toEqual([]);
    expect(closedRefsIn('reverts the change from #447')).toEqual([]);
  });

  it('reports each issue once however often it is claimed', () => {
    expect(closedRefsIn('Closes #5\nFixes #5')).toEqual([5]);
  });

  it('finds nothing in a commit that claims nothing', () => {
    expect(closedRefsIn('refactor: rename a file')).toEqual([]);
  });
});

describe('staleIssues', () => {
  it('flags an issue still open after a commit claimed to close it', () => {
    expect(staleIssues([443], [OPEN(443)])).toEqual([443]);
  });

  it('says nothing when the issue is closed', () => {
    expect(staleIssues([443], [{ number: 443, state: 'closed', labels: [] }])).toEqual([]);
  });

  /**
   * The escape hatch, and the whole point of the guard. Work fixed on an unreleased branch is
   * legitimately still open — the issue closes when the version ships. Labelling it is the act that
   * tells a contributor not to start, so the label is what the guard is really asking for.
   */
  it('accepts an open issue that is labelled fixed-pending-release', () => {
    expect(staleIssues([443], [OPEN(443, ['bug', 'fixed-pending-release'])])).toEqual([]);
  });

  it('is not fooled by a different label', () => {
    expect(staleIssues([443], [OPEN(443, ['help wanted', 'bug'])])).toEqual([443]);
  });

  it('flags several at once, in the order claimed', () => {
    expect(staleIssues([9, 3], [OPEN(3), OPEN(9)])).toEqual([9, 3]);
  });

  /**
   * An issue we could not look up is not evidence of anything. Failing on it would make the guard
   * red for a rate limit or a deleted issue, and a check that goes red for reasons unrelated to the
   * thing it guards is one people learn to ignore — which would cost more than the defect.
   */
  it('says nothing about an issue it could not resolve', () => {
    expect(staleIssues([443], [])).toEqual([]);
  });

  it('says nothing when no commit claimed to close anything', () => {
    expect(staleIssues([], [OPEN(443)])).toEqual([]);
  });
});
