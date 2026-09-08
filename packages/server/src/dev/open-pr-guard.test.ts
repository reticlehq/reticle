/**
 * The OPEN PR LIST lies in two directions, and both cost real contributor evenings.
 *
 * `stale-issue-guard.ts` catches one lie: an issue left open after a commit said it was closed. The
 * two here are its mirror image, about the PR list rather than the issue list, and nothing reads
 * that list today.
 *
 * **A PR whose work is already on `main`.** Ten were closed by hand on 2026-09-08, some open for
 * over two weeks, every one of them already merged under a different commit. #645's own merge commit
 * says "Merge PR #645" and GitHub still never closed it. The author does not know their work shipped;
 * a reviewer spends the time re-reviewing it; and it sits in the queue making the backlog read deeper
 * than it is.
 *
 * **An issue whose PR nobody can see.** GitHub does not surface "a PR references this" anywhere a
 * reader notices, and contributors' titles rarely carry the issue number — so an issue-number grep
 * over the PR list finds nothing. 19 of 53 open issues had an unannounced open PR. Four duplications
 * happened in one day because of it, including two by the maintainer.
 *
 * Both are HINTS, deliberately. Title matching cannot prove a PR landed, only that something with
 * its subject did, so the report asks the reader to check rather than telling them to close.
 */

import { describe, expect, it } from 'vitest';
import {
  landedPullRequests,
  landedPullRequestReport,
  issuesWithOpenPr,
  unannouncedClaimReport,
} from './open-pr-guard.js';

const PR = (number: number, title: string, body = '') => ({ number, title, body });

describe('landedPullRequests', () => {
  it('names a PR whose title already appears as a commit on main', () => {
    const prs = [PR(645, 'fix(server): say when a dev server is already listening')];
    const subjects = ['Merge PR #645: fix(server): say when a dev server is already listening'];
    expect(landedPullRequests(prs, subjects)).toEqual([645]);
  });

  it('matches a squash merge, where the subject gains a (#NNN) suffix', () => {
    const prs = [PR(829, 'fix(server): resolve a reused lease the way the mint path resolves it')];
    const subjects = [
      'fix(server): resolve a reused lease the way the mint path resolves it (#829)',
    ];
    expect(landedPullRequests(prs, subjects)).toEqual([829]);
  });

  it('is silent on a PR whose subject is nowhere on main', () => {
    expect(
      landedPullRequests([PR(1, 'feat: something nobody merged')], ['chore: unrelated']),
    ).toEqual([]);
  });

  it('does not match on a shared prefix — a conventional-commit scope is not a subject', () => {
    // Every PR here starts `fix(server): `. Matching on that would report the entire backlog as
    // landed, which is the failure that makes a guard get switched off on its first run.
    const prs = [PR(1, 'fix(server): one thing'), PR(2, 'fix(server): a different thing')];
    expect(landedPullRequests(prs, ['fix(server): one thing (#1)'])).toEqual([1]);
  });

  it('ignores a title too short to be evidence of anything', () => {
    // A one-word title would substring-match half of history. Better to say nothing.
    expect(landedPullRequests([PR(1, 'wip')], ['wip: unrelated work'])).toEqual([]);
  });
});

describe('issuesWithOpenPr', () => {
  it('maps an open issue to the open PR that references it', () => {
    const prs = [PR(870, 'fix(server): warn when a scope shrank', 'Closes #787.')];
    expect(issuesWithOpenPr(prs, [787, 123])).toEqual([{ issue: 787, prs: [870] }]);
  });

  it('reports BOTH PRs when two reference the same issue', () => {
    // #799 really had this shape, and neither author could see the other.
    const prs = [PR(832, 'a', 'Closes #799'), PR(837, 'b', 'part of #799')];
    expect(issuesWithOpenPr(prs, [799])).toEqual([{ issue: 799, prs: [832, 837] }]);
  });

  it('counts a bare reference, not only a closing verb', () => {
    // The opposite call from `closedRefsIn`, and deliberately so: there the question is "what does
    // this commit CLAIM to close", here it is "would a contributor want to know this exists".
    expect(issuesWithOpenPr([PR(1, 't', 'related to #5')], [5])).toEqual([{ issue: 5, prs: [1] }]);
  });

  it('ignores references to issues that are not open', () => {
    expect(issuesWithOpenPr([PR(1, 't', 'Closes #999')], [5])).toEqual([]);
  });

  it('does not report a PR referencing only itself', () => {
    // A PR body quoting its own number is noise, not a claim on an issue.
    expect(issuesWithOpenPr([PR(42, 't', 'supersedes #42')], [42])).toEqual([]);
  });
});

describe('the reports say what to do, not just what is wrong', () => {
  it('the landed report asks the reader to verify rather than asserting', () => {
    const text = landedPullRequestReport([645]);
    expect(text).toContain('#645');
    // Load-bearing: a title match is evidence, not proof, and the guard must not tell anyone to
    // close a contributor's work on a substring.
    expect(text).toMatch(/merge-base|verify|check/i);
  });

  it('the claim report names the PR a contributor would otherwise duplicate', () => {
    const text = unannouncedClaimReport([{ issue: 787, prs: [870] }]);
    expect(text).toContain('#787');
    expect(text).toContain('#870');
  });

  it('both are empty-safe, so a clean run prints nothing', () => {
    expect(landedPullRequestReport([])).toBe('');
    expect(unannouncedClaimReport([])).toBe('');
  });
});
