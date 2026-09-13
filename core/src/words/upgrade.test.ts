import { describe, expect, it } from 'vitest';
import {
  buildUpgradeHint,
  CloudCapability,
  isCloudCapability,
  UpgradeHintSchema,
  UPGRADE_HINT_SILENCE_ENV,
} from './upgrade.js';

describe('upgrade-hint contract', () => {
  it('builds a schema-valid hint for every capability', () => {
    for (const capability of Object.values(CloudCapability)) {
      const hint = buildUpgradeHint(capability);
      const parsed = UpgradeHintSchema.safeParse(hint);
      expect(parsed.success).toBe(true);
      expect(hint.capability).toBe(capability);
      expect(hint.reason.length).toBeGreaterThan(0);
      expect(hint.unlockedBy.length).toBeGreaterThan(0);
    }
  });

  it('points every hint at a valid learn-more URL', () => {
    const hint = buildUpgradeHint(CloudCapability.SHARE_PROOF);
    expect(() => new URL(hint.learnMoreUrl)).not.toThrow();
  });

  it('narrows unknown wire values to a capability', () => {
    expect(isCloudCapability('share_proof')).toBe(true);
    expect(isCloudCapability('not_a_capability')).toBe(false);
    expect(isCloudCapability(42)).toBe(false);
  });

  it('rejects a malformed hint (bad url, missing fields)', () => {
    expect(UpgradeHintSchema.safeParse({ capability: 'share_proof' }).success).toBe(false);
    expect(
      UpgradeHintSchema.safeParse({
        capability: 'share_proof',
        reason: 'x',
        unlockedBy: 'y',
        learnMoreUrl: 'not-a-url',
      }).success,
    ).toBe(false);
  });

  it('exposes a stable env switch name for silencing', () => {
    expect(UPGRADE_HINT_SILENCE_ENV).toBe('RETICLE_NO_UPSELL');
  });
});
