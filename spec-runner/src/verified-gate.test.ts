import { Verified } from '@reticlehq/core';
import { ReticleTool } from '@reticlehq/server';
import { describe, expect, it } from 'vitest';
import { expectText } from './matchers.js';
import { createTestContext } from './test-context.js';

/**
 * The spec runner must gate on the field the tool says to gate on.
 *
 * `reticle_assert` and `reticle_act_and_wait` both return `verified` beside `pass`, and the two are
 * allowed to disagree. `pass` is the raw predicate match; `verified` is that match after the honesty
 * layer has had its say. `act_and_wait`'s own schema calls `verified` "THE field to gate on", and
 * `assert-contradiction-plumbing.test.ts` puts it plainly: a UI that rendered success over a POST
 * that returned 500 yields `pass: true, verified: "no", verifiedReason: "contradicted"`, and
 * "`pass:true` with `verified:"no"` IS the product".
 *
 * `spec-runner` is the package whose entire job is turning that into a CI outcome, and it read
 * `pass` alone. So the one verdict the product exists to produce, a contradicted green, was the one
 * a spec reported as passing.
 */
const CONTRADICTED = {
  pass: true,
  verified: Verified.NO,
  verifiedReason: 'contradicted',
  because: 'the app fired "compose:generated" while POST /api/generate-script returned 500',
  contradictions: [{ claim: 'the app fired "compose:generated"', detail: 'POST /api → 500' }],
};

describe('a contradicted verdict fails the spec, however green the raw predicate was', () => {
  it('expectText fails when the daemon overturned the match', async () => {
    const invoke = (): Promise<unknown> => Promise.resolve(CONTRADICTED);
    await expect(expectText({ invoke }, 'Saved')).rejects.toThrow();
  });

  it('carries the reason the daemon gave rather than inventing one', async () => {
    const invoke = (): Promise<unknown> => Promise.resolve(CONTRADICTED);
    await expect(expectText({ invoke }, 'Saved')).rejects.toThrow(/compose:generated|500/);
  });

  it('act_and_wait fails when verified is no beside a passing nested verdict', async () => {
    const invoke = (tool: string): Promise<unknown> => {
      if (ReticleTool.QUERY === tool) return Promise.resolve({ elements: [{ ref: 'e1' }] });
      // `verified` sits at the TOP level of the act_and_wait result; the nested `verdict` object
      // carries only the raw predicate match. That split is why reading `verdict.pass` alone missed
      // the overturn.
      return Promise.resolve({ ...CONTRADICTED, verdict: { pass: true } });
    };
    const t = createTestContext(invoke);
    // Asserting on the REASON, not just that it threw: a fake that rejects for some unrelated
    // setup problem would otherwise satisfy this test while proving nothing.
    await expect(
      t.actAndWait('save-button', 'click', { kind: 'text', contains: 'Saved' }),
    ).rejects.toThrow(/compose:generated|500/);
  });
});

describe('it does not change the verdicts that were already right', () => {
  it('a clean green still passes', async () => {
    const invoke = (): Promise<unknown> => Promise.resolve({ pass: true, verified: Verified.YES });
    await expect(expectText({ invoke }, 'Saved')).resolves.toBeUndefined();
  });

  it('an ordinary failure still fails', async () => {
    const invoke = (): Promise<unknown> =>
      Promise.resolve({ pass: false, verified: Verified.NO, failureReason: 'no element matched' });
    await expect(expectText({ invoke }, 'Saved')).rejects.toThrow(/no element matched/);
  });

  /** A daemon too old to send the field must keep working exactly as before. */
  it('falls back to pass when the daemon sent no verified field', async () => {
    const invoke = (): Promise<unknown> => Promise.resolve({ pass: true });
    await expect(expectText({ invoke }, 'Saved')).resolves.toBeUndefined();
  });

  /**
   * Deliberately unchanged. The tool's own schema says "unknown is NOT failure — it means the
   * evidence could not decide... which calls for a better check rather than a code change". Whether
   * a CI spec should go red, green or skipped on that is a product decision, not one to slip in
   * under a false-green fix, so `unknown` keeps following `pass` exactly as it does today.
   */
  it('leaves unknown following pass, as it does today', async () => {
    const invoke = (): Promise<unknown> =>
      Promise.resolve({ pass: true, verified: Verified.UNKNOWN });
    await expect(expectText({ invoke }, 'Saved')).resolves.toBeUndefined();
  });
});
