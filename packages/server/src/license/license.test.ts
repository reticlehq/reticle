import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import {
  assertEnterprise,
  assertEnterpriseFromEnv,
  describeLicense,
  EnterpriseLicenseError,
  LICENSE_KEY_ENV,
  LICENSE_PUBLIC_KEY_ENV,
  LicenseStatus,
  signLicenseKey,
  verifyLicenseKey,
  type GateContext,
  type LicensePayload,
} from './license.js';

const NOW = 1_700_000_000_000;
const FUTURE = NOW + 100_000;
const PAST = NOW - 1;

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const payload = (over: Partial<LicensePayload> = {}): LicensePayload => ({
  org: 'acme',
  plan: 'enterprise',
  exp: FUTURE,
  ...over,
});
const key = (over: Partial<LicensePayload> = {}) => signLicenseKey(payload(over), privateKey);

describe('verifyLicenseKey', () => {
  it('accepts a well-formed, unexpired, correctly-signed key', () => {
    const check = verifyLicenseKey(key(), publicKey, NOW);
    expect(check.status).toBe(LicenseStatus.VALID);
    if (check.status === LicenseStatus.VALID) expect(check.payload.org).toBe('acme');
  });

  it('reports missing / malformed / expired distinctly', () => {
    expect(verifyLicenseKey(undefined, publicKey, NOW).status).toBe(LicenseStatus.MISSING);
    expect(verifyLicenseKey('no-separator', publicKey, NOW).status).toBe(LicenseStatus.MALFORMED);
    expect(verifyLicenseKey(key({ exp: PAST }), publicKey, NOW).status).toBe(LicenseStatus.EXPIRED);
  });

  it('rejects a tampered payload as a bad signature', () => {
    const valid = key();
    const otherPayload = Buffer.from(JSON.stringify(payload({ org: 'evil' })), 'utf8').toString(
      'base64url',
    );
    const tampered = `${otherPayload}.${valid.split('.')[1]}`;
    expect(verifyLicenseKey(tampered, publicKey, NOW).status).toBe(LicenseStatus.BAD_SIGNATURE);
  });

  it('rejects a key signed by a different issuer', () => {
    const other = generateKeyPairSync('ed25519');
    const foreign = signLicenseKey(payload(), other.privateKey);
    expect(verifyLicenseKey(foreign, publicKey, NOW).status).toBe(LicenseStatus.BAD_SIGNATURE);
  });
});

describe('assertEnterprise', () => {
  const ctx = (over: Partial<GateContext> = {}): GateContext => ({
    requireLicense: true,
    now: () => NOW,
    publicKey,
    ...over,
  });

  it('is a no-op in dev/eval (requireLicense:false), even with no key', () => {
    expect(() => assertEnterprise('audit-log', ctx({ requireLicense: false }))).not.toThrow();
  });

  it('passes in production with a valid key', () => {
    expect(() => assertEnterprise('audit-log', ctx({ key: key() }))).not.toThrow();
  });

  it('throws in production with no key', () => {
    expect(() => assertEnterprise('audit-log', ctx())).toThrow(EnterpriseLicenseError);
  });

  it('throws when the key does not cover the requested feature', () => {
    expect(() => assertEnterprise('audit-log', ctx({ key: key({ features: ['sso'] }) }))).toThrow(
      /feature-not-licensed/,
    );
  });
});

describe('env-resolved activation (describeLicense / assertEnterpriseFromEnv)', () => {
  const PUBKEY_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const withPubKey = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    [LICENSE_PUBLIC_KEY_ENV]: PUBKEY_PEM,
    ...over,
  });

  it('no issuer key configured → evaluation mode', () => {
    expect(describeLicense(NOW, {}).status).toBe('eval');
  });

  it('valid key → active, with org/plan/expiry', () => {
    const report = describeLicense(NOW, withPubKey({ [LICENSE_KEY_ENV]: key() }));
    expect(report.status).toBe('active');
    expect(report.org).toBe('acme');
  });

  it('issuer key but no license key → missing', () => {
    expect(describeLicense(NOW, withPubKey()).status).toBe('missing');
  });

  it('expired and garbage keys are reported distinctly', () => {
    expect(describeLicense(NOW, withPubKey({ [LICENSE_KEY_ENV]: key({ exp: PAST }) })).status).toBe(
      'expired',
    );
    expect(describeLicense(NOW, withPubKey({ [LICENSE_KEY_ENV]: 'garbage' })).status).toBe(
      'invalid',
    );
  });

  it('assertEnterpriseFromEnv: free in eval, enforced once an issuer key is configured', () => {
    expect(() => assertEnterpriseFromEnv('audit-log', NOW, {})).not.toThrow();
    expect(() =>
      assertEnterpriseFromEnv('audit-log', NOW, withPubKey({ [LICENSE_KEY_ENV]: key() })),
    ).not.toThrow();
    expect(() => assertEnterpriseFromEnv('audit-log', NOW, withPubKey())).toThrow(
      EnterpriseLicenseError,
    );
  });

  it('a baked-in issuer key fails closed: enforcement cannot be disabled by unsetting env', () => {
    // Simulates a release build (baked key present) with an operator who never sets the env var.
    // Old behavior: eval mode, features free. New behavior: enforced, throws without a valid key.
    expect(() => assertEnterpriseFromEnv('audit-log', NOW, {}, PUBKEY_PEM)).toThrow(
      EnterpriseLicenseError,
    );
    expect(describeLicense(NOW, {}, PUBKEY_PEM).status).toBe('missing');
    // A valid customer key still activates against the baked issuer key.
    expect(describeLicense(NOW, { [LICENSE_KEY_ENV]: key() }, PUBKEY_PEM).status).toBe('active');
  });

  it('the baked issuer key wins over an env public key (operator cannot swap in their own)', () => {
    const attacker = generateKeyPairSync('ed25519');
    const attackerPem = attacker.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    // Operator bakes nothing but tries to point env at THEIR key + a self-signed license — with a real
    // baked key, the env key is ignored, so their self-signed license fails signature verification.
    const selfSigned = signLicenseKey(payload(), attacker.privateKey);
    expect(
      describeLicense(
        NOW,
        { [LICENSE_PUBLIC_KEY_ENV]: attackerPem, [LICENSE_KEY_ENV]: selfSigned },
        PUBKEY_PEM,
      ).status,
    ).toBe('invalid');
  });
});
