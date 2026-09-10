import { describe, expect, it } from 'vitest';
import { Verified } from '@reticlehq/core';
import { citeCheck, correctionsAmong, decides, isAwaitingOutcome } from './late-answer.js';

/**
 * When a later verdict corrects an earlier one, and — mostly — when it does not.
 *
 * The specification has said from the start that a verdict may be superseded when late evidence
 * lands, and nothing produced one until now. The risk in building it is not that corrections
 * fail to appear; it is that the WRONG ones do. A correction is a claim that a later observation
 * answered an earlier question, and attaching that to two records which merely look similar is
 * inventing evidence about evidence — silently, because both records are well formed.
 *
 * So most of what follows is about refusing.
 */

const pending = (claim: string) => ({
  claim,
  verified: Verified.UNKNOWN,
  reason: 'outcome_pending',
});
const dirty = (claim: string) => ({
  claim,
  verified: Verified.UNKNOWN,
  reason: 'unclean_capture',
});
const answered = (claim: string, verified: Verified = Verified.YES) => ({ claim, verified });

describe('what counts as a question that can be answered later', () => {
  it('an outcome that has not arrived is open', () => {
    expect(isAwaitingOutcome(pending('the order posted'))).toBe(true);
  });

  it('a capture that could not be read is NOT open', () => {
    // Both are `unknown`, and only one can be settled by waiting. Superseding this would claim a
    // later, unrelated observation resolved a blind spot -- which nothing observed.
    expect(isAwaitingOutcome(dirty('the order posted'))).toBe(false);
  });

  it('an SDK too old to record a reason leaves nothing to answer', () => {
    expect(isAwaitingOutcome({ claim: 'x', verified: Verified.UNKNOWN })).toBe(false);
  });

  it('only yes and no decide anything', () => {
    expect(decides(answered('x'))).toBe(true);
    expect(decides(answered('x', Verified.NO))).toBe(true);
    expect(decides(pending('x'))).toBe(false);
    expect(decides({ claim: 'x', verified: Verified.NO_FAULT })).toBe(false);
  });
});

describe('a correction is recorded', () => {
  it('when a later verdict decides a claim that was left pending', () => {
    const found = correctionsAmong([pending('the order posted'), answered('the order posted')]);
    expect([...found]).toEqual([[1, 0]]);
  });

  it('when the late answer is a NO — a correction is not good news, it is news', () => {
    const found = correctionsAmong([
      pending('the order posted'),
      answered('the order posted', Verified.NO),
    ]);
    expect([...found]).toEqual([[1, 0]]);
  });

  it('citing the earlier check by the name the protocol spells', () => {
    expect(citeCheck('drive-7', 0)).toBe('drive-7#c1');
  });
});

describe('a correction is refused', () => {
  it('for a different claim, however close in time', () => {
    // Matching on anything looser than the claim attaches an answer to a question nobody asked,
    // and does it silently, because both records are perfectly well formed.
    expect([
      ...correctionsAmong([pending('the order posted'), answered('the cart emptied')]),
    ]).toEqual([]);
  });

  it('when the later verdict is itself undecided', () => {
    // The same question asked twice is not progress, and recording it as a correction would make
    // a run look like it was converging when it was not.
    expect([...correctionsAmong([pending('x'), pending('x')])]).toEqual([]);
  });

  it('when the earlier verdict was never open in the first place', () => {
    expect([...correctionsAmong([dirty('x'), answered('x')])]).toEqual([]);
  });

  it('when the answer came BEFORE the question', () => {
    // Order is the whole content of the claim. A verdict cannot correct one that came after it.
    expect([...correctionsAmong([answered('x'), pending('x')])]).toEqual([]);
  });
});

describe('a claim asked three times has one question and one answer', () => {
  it('corrects the FIRST open verdict, not the most recent', () => {
    // Taking the latest would silently drop the middle record from the chain a reader follows
    // back, leaving a correction that cites a verdict nobody can find a question for.
    const found = correctionsAmong([pending('x'), pending('x'), answered('x')]);
    expect([...found]).toEqual([[2, 0]]);
  });

  it('does not correct twice from one answer', () => {
    const found = correctionsAmong([pending('x'), answered('x'), answered('x')]);
    expect([...found]).toEqual([[1, 0]]);
  });
});
