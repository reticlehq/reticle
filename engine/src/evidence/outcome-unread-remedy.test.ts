/**
 * The `outcome_unread` verdict is the sentence the reporter actually saw — six times.
 *
 * My own earlier fix taught `bodiesNotCaptured` and `reconcile` to check the SDK version before
 * advising `captureNetworkBodies`, and MISSED this one, which inlines the same advice. It is the
 * highest-traffic of the three: every 2xx write whose body went unread produces it, which is exactly
 * the loop the report describes.
 *
 * Found by going back to the issue rather than to my own diff — the grep that found the first two
 * sites looked for callers of `bodiesNotCaptured`, and this site does not call it.
 */

import { describe, expect, it } from 'vitest';
import { Verified, VerifiedReason } from '@reticlehq/core';
import { decideVerified } from './verified.js';

const unreadWrite = (over: Record<string, unknown> = {}): Parameters<typeof decideVerified>[0] =>
  ({
    pass: true,
    honesty: { integrity: { clean: true } },
    settled: true,
    outcomeUnread: ['POST /api/orders 201'],
    ...over,
  }) as unknown as Parameters<typeof decideVerified>[0];

describe('the unread-outcome verdict does not advise an impossible setting', () => {
  it('still grades unknown — the body really was never read', () => {
    const verdict = decideVerified(unreadWrite({ sdkVersion: '2.1.0' }));
    expect(verdict.verified).toBe(Verified.UNKNOWN);
    expect(verdict.verifiedReason).toBe(VerifiedReason.OUTCOME_UNREAD);
  });

  it('names the versions instead of the setting when the SDK predates it', () => {
    const verdict = decideVerified(unreadWrite({ sdkVersion: '2.1.0' }));
    expect(verdict.because).toContain('2.1.0');
    expect(
      verdict.because,
      'this is the sentence that was repeated six times at a repo that could not follow it',
    ).not.toContain('captureNetworkBodies');
  });

  it('still names the setting on an SDK that has it', () => {
    expect(decideVerified(unreadWrite({ sdkVersion: '2.13.1' })).because).toContain(
      'captureNetworkBodies',
    );
  });

  it('names the setting when the version is unknown', () => {
    expect(decideVerified(unreadWrite()).because).toContain('captureNetworkBodies');
  });

  it('keeps naming the calls whose outcome went unread', () => {
    // The labels are why an agent can tell WHICH write this caveat is about; the remedy change must
    // not cost that.
    expect(decideVerified(unreadWrite()).because).toContain('POST /api/orders 201');
  });
});
