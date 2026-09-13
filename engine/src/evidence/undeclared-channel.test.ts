import { describe, expect, it } from 'vitest';
import { ChannelId, Verified, VerifiedReason } from '@reticlehq/core';
import { HonestyGrade } from './honesty.js';
import { decideVerified } from './verified.js';

/**
 * A claim that reads something this implementation never said it could see is not answerable.
 *
 * The rule, in one sentence: **a `yes` requires that every channel the claim reads was declared
 * observable by the implementation that answered.** A claim reading an undeclared channel is
 * `unknown` -- never `yes`, and never `no` -- with a reason naming the channel.
 *
 * Both halves of that matter, and the second is the less obvious one. Saying `no` would be a
 * confident wrong answer: "the store did not change" and "nothing was watching the store" produce
 * the same empty result, and reporting the second as the first is how a check becomes a liar. The
 * system already knew this in one place -- there is a blind-spot rule that forces `unknown` when it
 * catches the situation at assert time. A declaration is the same fact known at connect time, which
 * is early enough to refuse before the action is spent rather than after.
 *
 * Absence of a declaration is not absence of the channel. An implementation that says nothing is an
 * older one that watched whatever it watched, and refusing all of its claims would break every
 * existing install to close a gap it does not have.
 */

const CLEAN = {
  grade: HonestyGrade.SIGNAL,
  coverage: { partial: false },
  integrity: { clean: true, issues: [] },
};

describe('a claim that reads an undeclared channel', () => {
  it('is unknown, and says which channel it could not read', () => {
    const verdict = decideVerified({
      pass: true,
      declaredConsequence: true,
      honesty: CLEAN,
      channelsRead: [ChannelId.STATE],
      channelsObservable: [ChannelId.UI, ChannelId.NET],
    });
    expect(verdict.verified).toBe(Verified.UNKNOWN);
    expect(verdict.verifiedReason).toBe(VerifiedReason.CAPABILITY_ABSENT);
    expect(verdict.because).toContain(ChannelId.STATE);
  });

  it('is not reported as a failure, even when the claim did not hold', () => {
    // The half that would be easy to miss. If a claim reads a channel nobody was watching, "it did
    // not happen" is not something anybody observed -- and saying `no` blames the app for a gap in
    // the tooling. This is the confident wrong answer the whole rule exists to prevent.
    const verdict = decideVerified({
      pass: false,
      declaredConsequence: true,
      honesty: CLEAN,
      channelsRead: [ChannelId.STATE],
      channelsObservable: [ChannelId.UI],
    });
    expect(verdict.verified).toBe(Verified.UNKNOWN);
    expect(verdict.verifiedReason).toBe(VerifiedReason.CAPABILITY_ABSENT);
  });

  it('is answered normally when every channel it reads was declared', () => {
    const verdict = decideVerified({
      pass: true,
      declaredConsequence: true,
      honesty: CLEAN,
      channelsRead: [ChannelId.UI, ChannelId.NET],
      channelsObservable: [ChannelId.UI, ChannelId.NET, ChannelId.STATE],
    });
    expect(verdict.verified).toBe(Verified.YES);
  });

  it('is answered normally when the implementation declared nothing at all', () => {
    // Back-compat, and it is not a detail: every SDK in the field today declares nothing. Reading
    // that silence as "observes nothing" would turn every verdict everywhere into `unknown`.
    const verdict = decideVerified({
      pass: true,
      declaredConsequence: true,
      honesty: CLEAN,
      channelsRead: [ChannelId.STATE],
    });
    expect(verdict.verified).toBe(Verified.YES);
  });

  it('is decided before anything else looks at the claim', () => {
    // Ordering is the point. If a later clause reached a verdict first, an unanswerable claim would
    // be reported as something else -- most likely as a failure, which is the outcome above.
    const verdict = decideVerified({
      pass: false,
      declaredConsequence: true,
      honesty: { ...CLEAN, integrity: { clean: false, issues: ['something else wrong'] } },
      channelsRead: [ChannelId.STATE],
      channelsObservable: [ChannelId.UI],
    });
    expect(verdict.verifiedReason).toBe(VerifiedReason.CAPABILITY_ABSENT);
  });
});
