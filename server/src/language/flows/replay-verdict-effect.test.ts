import { describe, expect, it } from 'vitest';
import { ReplayStatus, Verified } from '@reticlehq/core';
import { JournalVerdictEffectSchema } from '@reticlehq/core/artifacts';
import { replayVerdictEffect } from './flow-result.js';

/*
 * A session whose only work was a failing `reticle_verify {action:"flows"}` replay ended "Reticle
 * result: not proved · nothing was checked", beside the replay's own "1 of 1 check did not hold". A
 * replay is a check of the session that ran it.
 */
describe('a replay, as a check of the session that ran it', () => {
  it('held, failed or undecided as the replay was', () => {
    const ok = replayVerdictEffect('sign-in', ReplayStatus.OK, false);
    expect(JournalVerdictEffectSchema.parse(ok).verified).toBe(Verified.YES);
    expect(replayVerdictEffect('sign-in', ReplayStatus.ERROR, false).verified).toBe(Verified.NO);
    expect(replayVerdictEffect('sign-in', ReplayStatus.DRIFT, false).verified).toBe(
      Verified.UNKNOWN,
    );
    // A replay of a flow that asserts nothing proves nothing, whatever it passed.
    expect(replayVerdictEffect('sign-in', ReplayStatus.OK, true).verified).toBe(Verified.UNKNOWN);
    expect(ok.claim).toContain('sign-in');
  });
});
