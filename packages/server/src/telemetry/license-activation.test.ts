import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { LicenseActivation } from '@reticlehq/core';
import { licenseFacts } from './license-activation.js';
import { LICENSE_KEY_ENV, LICENSE_PUBLIC_KEY_ENV, signLicenseKey } from '../license/license.js';

const NOW = 1_700_000_000_000;
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const PUBKEY_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const LID = 'aa1bdcc5-2db3-43e5-b46c-517734936c5d';

const key = (exp: number, org = 'Northwind Bank') =>
  signLicenseKey({ lid: LID, org, plan: 'enterprise', exp }, privateKey);
const licensed = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  [LICENSE_PUBLIC_KEY_ENV]: PUBKEY_PEM,
  ...over,
});

describe('licenseFacts', () => {
  it('reports id, plan and status for an active license', () => {
    const facts = licenseFacts(NOW, licensed({ [LICENSE_KEY_ENV]: key(NOW + 100_000) }));
    expect(facts).toEqual({
      licenseId: LID,
      licensePlan: 'enterprise',
      licenseStatus: LicenseActivation.ACTIVE,
    });
  });

  it('NEVER puts the organisation name on the wire', () => {
    const facts = licenseFacts(
      NOW,
      licensed({ [LICENSE_KEY_ENV]: key(NOW + 100_000, 'Northwind') }),
    );
    expect(JSON.stringify(facts)).not.toContain('Northwind');
  });

  it('keeps reporting status once a key lapses, which is what makes a lapse visible', () => {
    // The renewal signal. `licenseId` drops (nothing verified), but a machine that used to report
    // `active` now reports `expired` — on identity alone this would be indistinguishable from churn.
    const facts = licenseFacts(NOW, licensed({ [LICENSE_KEY_ENV]: key(NOW - 1) }));
    expect(facts.licenseStatus).toBe(LicenseActivation.EXPIRED);
    expect(facts.licenseId).toBeUndefined();
    expect(facts.licensePlan).toBeUndefined();
  });

  it('reports missing and invalid distinctly', () => {
    expect(licenseFacts(NOW, licensed()).licenseStatus).toBe(LicenseActivation.MISSING);
    expect(licenseFacts(NOW, licensed({ [LICENSE_KEY_ENV]: 'garbage' })).licenseStatus).toBe(
      LicenseActivation.INVALID,
    );
  });

  it('says NOTHING on a build with no issuer key baked — every OSS install', () => {
    // Absence already means "not a licensed build". Emitting `eval` would add three properties to the
    // dominant population to say so at a cost.
    expect(licenseFacts(NOW, {})).toEqual({});
  });

  it('reports a mis-built production release rather than staying silent about it', () => {
    // Production with no resolvable issuer key is a release whose gate is off. That is the one
    // no-key case worth hearing about, and describeLicense already distinguishes it from eval.
    expect(licenseFacts(NOW, { NODE_ENV: 'production' }).licenseStatus).toBe(
      LicenseActivation.INVALID,
    );
  });

  it('uses the EVENT clock, so a mid-session expiry is visible on the event it expires on', () => {
    const env = licensed({ [LICENSE_KEY_ENV]: key(NOW + 1_000) });
    expect(licenseFacts(NOW, env).licenseStatus).toBe(LicenseActivation.ACTIVE);
    expect(licenseFacts(NOW + 2_000, env).licenseStatus).toBe(LicenseActivation.EXPIRED);
  });
});
