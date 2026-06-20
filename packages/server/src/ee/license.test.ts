import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import {
  assertEnterprise,
  EnterpriseLicenseError,
  LicenseStatus,
  signLicenseKey,
  verifyLicenseKey,
  type GateContext,
  type LicensePayload,
} from './license.js';
import { recordAuditEvent } from './audit-log.js';

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

describe('gated example feature', () => {
  it('recordAuditEvent works in dev and is blocked in unlicensed production', () => {
    const event = { actor: 'a', action: 'x', at: NOW };
    expect(recordAuditEvent(event, { requireLicense: false, now: () => NOW })).toEqual(event);
    expect(() =>
      recordAuditEvent(event, { requireLicense: true, now: () => NOW, publicKey }),
    ).toThrow(EnterpriseLicenseError);
  });
});
