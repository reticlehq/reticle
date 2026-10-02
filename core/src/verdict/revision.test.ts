import { describe, expect, it } from 'vitest';
import { RunConfidence, RunIdSchema, VerdictStatus, type RunVerdict } from './verification-run.js';
import { citeVerdict, isRevisionOf, reviseVerdict } from './revision.js';

/**
 * A verdict can be corrected when the truth arrives late.
 *
 * Today it cannot, and that is a real unsoundness rather than a missing convenience. Two of the
 * reasons a verdict can carry mean, in plain words, "the truth has not arrived yet" -- a write the
 * server accepted for later processing, and a window that closed while something was still in
 * flight. Both are final the moment they are made. A write that is accepted and then succeeds is
 * permanently recorded as `unknown`, and nothing anywhere can ever say otherwise.
 *
 * The correction is small and it has one hard rule: **a revision never edits the earlier verdict.**
 * It is a new one that cites the old. Rewriting a verdict in place would destroy the only evidence
 * that the first answer was ever given, and "we always knew" is exactly the shape of the problem
 * this whole system exists to prevent.
 */

const RUN = RunIdSchema.parse('run-1');
const PENDING: RunVerdict = {
  status: VerdictStatus.UNKNOWN,
  reasons: ['the write was accepted and had not finished when the window closed'],
  confidence: RunConfidence.LOW,
  blockingRisks: 0,
  checkId: 'save-succeeds',
};

describe('correcting a verdict when the truth arrives late', () => {
  it('cites the verdict it replaces, by run and by check', () => {
    const revised = reviseVerdict({
      earlier: PENDING,
      earlierRunId: RUN,
      status: VerdictStatus.PASS,
      reasons: ['the accepted write finished, and it succeeded'],
    });
    expect(revised.supersedes).toBe(citeVerdict(RUN, 'save-succeeds'));
    expect(isRevisionOf(revised, RUN, 'save-succeeds')).toBe(true);
  });

  it('does not change the verdict it replaces', () => {
    // The hard rule. A revision that edited the earlier answer in place would erase the fact that
    // the first answer was ever given, and "we always knew" is the shape of the problem this whole
    // system exists to prevent.
    const before = JSON.stringify(PENDING);
    reviseVerdict({
      earlier: PENDING,
      earlierRunId: RUN,
      status: VerdictStatus.PASS,
      reasons: ['it finished'],
    });
    expect(JSON.stringify(PENDING)).toBe(before);
  });

  it('carries the new reasons, not the old ones', () => {
    const revised = reviseVerdict({
      earlier: PENDING,
      earlierRunId: RUN,
      status: VerdictStatus.FAIL,
      reasons: ['the accepted write finished, and it failed'],
    });
    expect(revised.reasons).toEqual(['the accepted write finished, and it failed']);
    expect(revised.status).toBe(VerdictStatus.FAIL);
  });

  it('refuses to revise a verdict that never said which check it was about', () => {
    // A citation nobody can resolve is not a citation. Without a check to point at, a revision
    // would claim to correct something unidentifiable, which is worse than no revision at all.
    expect(() =>
      reviseVerdict({
        earlier: { ...PENDING, checkId: undefined },
        earlierRunId: RUN,
        status: VerdictStatus.PASS,
        reasons: ['it finished'],
      }),
    ).toThrow(/which check/i);
  });

  it('can tell a revision of something else apart from a revision of this', () => {
    const revised = reviseVerdict({
      earlier: PENDING,
      earlierRunId: RUN,
      status: VerdictStatus.PASS,
      reasons: ['it finished'],
    });
    expect(isRevisionOf(revised, RUN, 'a-different-check')).toBe(false);
    expect(isRevisionOf(PENDING, RUN, 'save-succeeds')).toBe(false);
  });
});
