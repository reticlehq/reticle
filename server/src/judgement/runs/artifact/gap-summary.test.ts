/**
 * The gap, as a number the person who ran the session can actually see.
 *
 * Reticle's whole claim is that it measures the distance between what an agent believes happened
 * and what did. It measures that distance on every verdict, writes it into the journal, and then
 * shows nobody: the counts exist, the reasons exist, the contradictions exist, and there is no
 * surface anywhere that says "you made 14 claims, 9 held, 2 were false and 3 could not be decided,
 * and here is who owns each of those three".
 *
 * A FOLD over the journal, never a second store — the same rule `run-context.ts` next door states
 * and for the same reason: two ways to compute one number is worse than one, because the day they
 * disagree the disagreement lands inside a verdict.
 *
 * Nothing here sends anything anywhere. It is the local half on purpose.
 */

import { describe, expect, it } from 'vitest';
import { Verified, VerifiedReason, type JournalAction } from '@reticlehq/core';
import { gapSummary } from './gap-summary.js';

let seq = 0;
const claim = (
  verified: Verified,
  reason?: VerifiedReason,
  over: Record<string, unknown> = {},
): JournalAction =>
  ({
    tool: 'reticle_act_and_wait',
    at: (seq += 1),
    args: {},
    effect: {
      claim: `claim ${String(seq)}`,
      verified,
      ...(reason === undefined ? {} : { reason }),
      ...over,
    },
  }) as unknown as JournalAction;

/** An action that drove the app and asserted nothing — not a claim, and must not be counted as one. */
const droveOnly = (): JournalAction =>
  ({ tool: 'reticle_act', at: (seq += 1), args: {}, effect: {} }) as unknown as JournalAction;

describe('gapSummary', () => {
  it('counts only the actions that actually made a claim', () => {
    const summary = gapSummary([
      claim(Verified.YES, VerifiedReason.PROVED),
      droveOnly(),
      droveOnly(),
    ]);
    expect(summary.claims).toBe(1);
    expect(summary.held).toBe(1);
  });

  it('separates held, failed and undecided', () => {
    const summary = gapSummary([
      claim(Verified.YES, VerifiedReason.PROVED),
      claim(Verified.NO, VerifiedReason.ASSERTION_FAILED),
      claim(Verified.UNKNOWN, VerifiedReason.UNSETTLED),
    ]);
    expect(summary).toMatchObject({ claims: 3, held: 1, failed: 1, undecided: 1 });
  });

  /*
   * `no-fault` is the fourth answer and it is NOT a pass, NOT a failure and NOT an unknown: nothing
   * was declared, so nothing was checked. Folding it into any of the other three is how a session
   * that proved nothing reads as a session that proved something.
   */
  it('keeps `no-fault` apart from the other three', () => {
    const summary = gapSummary([claim(Verified.NO_FAULT, VerifiedReason.NOTHING_DECLARED)]);
    expect(summary).toMatchObject({
      claims: 1,
      held: 0,
      failed: 0,
      undecided: 0,
      nothingToProve: 1,
    });
  });

  /*
   * The reason an `unknown` is undecided is the only thing the reader can act on, and the four
   * owners imply four different next moves: wait, fix your app, fix the harness, look again.
   */
  it('attributes each undecided verdict to an owner', () => {
    const summary = gapSummary([
      claim(Verified.UNKNOWN, VerifiedReason.UNSETTLED),
      claim(Verified.UNKNOWN, VerifiedReason.OUTCOME_PENDING),
      claim(Verified.UNKNOWN, VerifiedReason.VERSION_SKEW),
      claim(Verified.UNKNOWN, VerifiedReason.UNCLEAN_CAPTURE),
    ]);
    expect(summary.undecidedBy).toEqual({
      environment: 2,
      harness: 1,
      'could-not-see': 1,
    });
  });

  it('says nothing about owners when nothing was undecided', () => {
    expect(gapSummary([claim(Verified.YES, VerifiedReason.PROVED)]).undecidedBy).toEqual({});
  });

  /*
   * A verdict a CHANNEL disagreed with is the thing this product exists to catch: the screen said it
   * worked and something else said it did not. It is counted apart from an ordinary failure because
   * the two mean different things to the reader — one is a check that failed, the other is a green
   * that would have been believed.
   */
  it('counts a contradicted verdict as a false green caught', () => {
    const summary = gapSummary([
      claim(Verified.NO, VerifiedReason.CONTRADICTED),
      claim(Verified.NO, VerifiedReason.ASSERTION_FAILED),
    ]);
    expect(summary.failed).toBe(2);
    expect(summary.falseGreensCaught).toBe(1);
  });

  it('carries each failure as what was claimed and what the engine said about it', () => {
    const summary = gapSummary([claim(Verified.NO, VerifiedReason.ASSERTION_FAILED)]);
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0]?.reason).toBe(VerifiedReason.ASSERTION_FAILED);
    expect(summary.failures[0]?.claim).toMatch(/^claim /);
  });

  /*
   * A record written before `reason` existed has none, and must not be read as though it did.
   * Counting it under an owner would invent an attribution nobody recorded.
   */
  it('does not invent an owner for a verdict that recorded no reason', () => {
    const summary = gapSummary([claim(Verified.UNKNOWN)]);
    expect(summary.undecided).toBe(1);
    expect(summary.undecidedBy).toEqual({});
  });

  /*
   * The journal stores `reason` as a free STRING, so it can hold a word written by an older engine
   * whose vocabulary this build does not have. An unrecognised reason is treated exactly like an
   * absent one rather than attributed to one of four buckets on the strength of its spelling.
   */
  it('does not attribute a reason it does not recognise', () => {
    const summary = gapSummary([
      claim(Verified.UNKNOWN, 'a_reason_from_a_later_engine' as VerifiedReason),
    ]);
    expect(summary.undecided).toBe(1);
    expect(summary.undecidedBy).toEqual({});
  });

  it('is empty, not absent, for a session that never drove anything', () => {
    expect(gapSummary([])).toMatchObject({ claims: 0, held: 0, failed: 0, undecided: 0 });
  });
});
