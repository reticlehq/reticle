/**
 * The body-clause pre-flight already says exactly what to do, so the envelope must not argue with it.
 *
 * `reticle_assert` / `act_and_wait` refuse a `bodyContains` / `bodyMatches` clause when the session
 * has DECLARED body capture off: nothing runs, no action is spent, and the refusal names the setting
 * to switch on (or says the SDK is too old for it to exist). The envelope then found no recovery
 * rule for that message and appended the feedback ask — "this error is not one Reticle recognizes …
 * may be a defect in Reticle" — on top of a refusal Reticle had just diagnosed itself. That spends
 * the agent's turn and fills the feedback channel with reports about a session setting.
 *
 * Driven through `bodyClauseRefusal` rather than a paraphrase of it: a classifier tested against its
 * author's idea of the message is one that agrees with itself and nothing else.
 */

import { describe, expect, it } from 'vitest';
import { RefusalReason } from '@reticlehq/core';
import { bodyClauseRefusal } from '@reticlehq/engine/evidence/body-capture-remedy.js';
import { buildErrorPayload, refusalReasonFor } from './error-recovery.js';

const NET = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: 'net',
  urlContains: '/api/orders',
  bodyContains: 'confirmed',
  ...over,
});

/** The refusal as the tool surface throws it, for a session that declared capture off. */
const refusalFor = (session: { captureBodies?: boolean; sdkVersion?: string }): string => {
  const refusal = bodyClauseRefusal(NET(), session);
  if (refusal === undefined) throw new Error('the pre-flight did not refuse — fixture is wrong');
  return refusal;
};

describe('the body-clause refusal is self-recovering, not a possible Reticle defect', () => {
  it('carries no feedback ask, on an SDK that HAS the setting', () => {
    const payload = buildErrorPayload(refusalFor({ captureBodies: false }));
    expect(payload.feedback, 'the refusal already named the setting to turn on').toBeUndefined();
    expect(payload.recovery, 'and it needs no second, generic hint').toBeUndefined();
    expect(payload.error).toContain('captureNetworkBodies');
  });

  /**
   * The other half of the remedy: an SDK older than body capture is told to upgrade, and that text
   * shares none of the wording of the one above. Both must land in the same bucket, or the message a
   * caller gets decides whether Reticle asks them to file a bug.
   */
  it('carries no feedback ask, on an SDK too old for the setting to exist', () => {
    const payload = buildErrorPayload(refusalFor({ captureBodies: false, sdkVersion: '2.1.0' }));
    expect(payload.feedback).toBeUndefined();
    expect(payload.error).toContain('body capture needs');
  });

  it('is reported as unsupported rather than other', () => {
    expect(refusalReasonFor(refusalFor({ captureBodies: false }))).toBe(RefusalReason.UNSUPPORTED);
    expect(refusalReasonFor(refusalFor({ captureBodies: false, sdkVersion: '2.1.0' }))).toBe(
      RefusalReason.UNSUPPORTED,
    );
  });
});
