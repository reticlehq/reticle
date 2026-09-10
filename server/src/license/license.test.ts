import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import {
  assertEnterprise,
  EnterpriseFeature,
  LICENSE_CONTACT,
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
  lid: 'lic_00000000-0000-4000-8000-000000000001',
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

  it('rejects a key with no license id — an unattributable key must be re-issued, not accepted', () => {
    const { lid: _dropped, ...noLid } = payload();
    const unsigned = Buffer.from(JSON.stringify(noLid), 'utf8');
    const forged = `${unsigned.toString('base64url')}.${signLicenseKey(payload(), privateKey).split('.')[1]}`;
    expect(verifyLicenseKey(forged, publicKey, NOW).status).toBe(LicenseStatus.MALFORMED);
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
    // The join key usage is attributed by — reported so `reticle license` can show it and support can
    // match a customer to their data without asking them for anything.
    expect(report.licenseId).toBe('lic_00000000-0000-4000-8000-000000000001');
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

  it('FAILS CLOSED in production when no issuer key resolves (a mis-built release must not run free)', () => {
    // dev/eval with no key is still free — a contributor/CI is never blocked.
    expect(() => assertEnterpriseFromEnv('audit-log', NOW, {})).not.toThrow();
    // But NODE_ENV=production with no baked key AND no env key is a broken release: DENY, don't unlock.
    expect(() => assertEnterpriseFromEnv('audit-log', NOW, { NODE_ENV: 'production' })).toThrow(
      /enterprise-gate-unconfigured/,
    );
    // A correctly-built production release (issuer key present) still enforces normally.
    expect(() =>
      assertEnterpriseFromEnv('audit-log', NOW, withPubKey({ NODE_ENV: 'production' })),
    ).toThrow(EnterpriseLicenseError); // no license key → still denied, but for 'missing', not misconfig
  });

  it('describeLicense flags a production eval-mode build as MISCONFIGURED, not benign eval', () => {
    expect(describeLicense(NOW, {}).status).toBe('eval'); // dev: benign
    const prod = describeLicense(NOW, { NODE_ENV: 'production' });
    expect(prod.status).toBe('invalid');
    expect(prod.detail).toContain('MISCONFIGURED');
  });

  it('the enterprise error points at the current contact address', () => {
    expect(new EnterpriseLicenseError('x', 'y').message).toContain('hey@reticle.sh');
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

describe('the release bakes the issuer key', () => {
  // The gate is only real if a PUBLISHED artifact carries the issuer key, and only `prepack` can put it
  // there: prepack starts with `rm -rf dist && tsc -b --force`, so a stamp applied anywhere earlier in
  // the release job is deleted and rebuilt away. That is not a hypothetical — the stamp first shipped as
  // a separate workflow step before `pnpm publish`, and the packed tarball came out with an empty key,
  // nothing having failed. Nothing else in the repo can see this: unit tests run against src, and the
  // gates never pack. So the ordering is pinned here.
  const PackageJsonSchema = z.object({ scripts: z.record(z.string()).optional() });
  const packageJson: unknown = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  );
  const prepack = PackageJsonSchema.parse(packageJson).scripts?.['prepack'] ?? '';

  it('stamps the issuer key during prepack, after the build that would erase it', () => {
    expect(prepack).toContain('stamp-issuer-key.mjs');
    expect(prepack.indexOf('stamp-issuer-key.mjs')).toBeGreaterThan(
      prepack.indexOf('tsc -b --force'),
    );
  });
});

describe('reticle license is not a dead end for somebody who has no key', () => {
  // It was the one command that talks about licensing, and it named neither what a licence unlocks nor
  // how to get one: it told an interested reader to set an environment variable and stopped there.
  const PUBKEY_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();

  it('every branch says where to get a key, and every UNLICENSED one says what is gated', () => {
    // The branch an unlicensed reader lands on is exactly the branch that gets forgotten, so all of
    // them are checked rather than the happy path.
    const branches = [
      describeLicense(NOW, {}),
      describeLicense(NOW, { [LICENSE_PUBLIC_KEY_ENV]: PUBKEY_PEM }),
      describeLicense(NOW, { [LICENSE_PUBLIC_KEY_ENV]: PUBKEY_PEM, [LICENSE_KEY_ENV]: key() }),
      describeLicense(NOW, {
        [LICENSE_PUBLIC_KEY_ENV]: PUBKEY_PEM,
        [LICENSE_KEY_ENV]: key({ exp: PAST }),
      }),
      describeLicense(NOW, { [LICENSE_PUBLIC_KEY_ENV]: PUBKEY_PEM, [LICENSE_KEY_ENV]: 'garbage' }),
      describeLicense(NOW, { [LICENSE_PUBLIC_KEY_ENV]: 'not-a-key' }),
      describeLicense(NOW, { NODE_ENV: 'production' }),
    ];
    for (const report of branches) {
      // Contact is unconditional: whatever went wrong, the reader needs somebody to write to.
      expect(report.contact, `${report.status} names no contact`).toBe(LICENSE_CONTACT);
      // The feature list is for a reader who has NOT bought. See the active-licence tests below.
      if ('active' === report.status) continue;
      expect(report.gated?.length, `${report.status} lists nothing as gated`).toBeGreaterThan(0);
    }
  });

  it('reports what this build actually gates, not a roadmap', () => {
    // Derived from the same registry the gate reads, so a feature that stops being gated stops being
    // advertised. Printing a roadmap as though it shipped is how a buyer finds out on day two.
    expect(describeLicense(NOW, {}).gated).toEqual(Object.values(EnterpriseFeature));
  });

  it('the gate and the CLI cannot name different features', () => {
    // assertEnterprise is called with a member, so an ee feature added without one is refused by a key
    // that lists it and never appears in what `reticle license` says is gated.
    for (const feature of Object.values(EnterpriseFeature)) {
      expect(() =>
        assertEnterprise(feature, {
          requireLicense: true,
          now: () => NOW,
          publicKey,
          key: key({ features: [feature] }),
        }),
      ).not.toThrow();
    }
  });
});

describe('what the fleet rehearsal caught', () => {
  const PUBKEY_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const env = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    [LICENSE_PUBLIC_KEY_ENV]: PUBKEY_PEM,
    ...over,
  });

  it('still names the customer once their key expires', () => {
    // Found by running six dummy customers through a packaged release: the lapsed one came out
    // UNATTRIBUTABLE. The whole point of reporting status through the failure states is to see a
    // renewal coming, and "somebody's key expired" is not a renewal signal if it cannot say WHOSE.
    // The signature still verifies on an expired key, so the id is as trustworthy as it ever was;
    // only the clock has moved.
    const report = describeLicense(NOW, env({ [LICENSE_KEY_ENV]: key({ exp: PAST }) }));
    expect(report.status).toBe('expired');
    expect(report.licenseId).toBe('lic_00000000-0000-4000-8000-000000000001');
  });

  it('a forged key is still anonymous, because its claims were never trustworthy', () => {
    // The line is the SIGNATURE, not the expiry. An unverified payload must never name a customer.
    const other = generateKeyPairSync('ed25519');
    const forged = signLicenseKey(payload(), other.privateKey);
    const report = describeLicense(NOW, env({ [LICENSE_KEY_ENV]: forged }));
    expect(report.status).toBe('invalid');
    expect(report.licenseId).toBeUndefined();
  });

  it('says so when a valid key covers nothing this build gates', () => {
    // Also from the rehearsal: a customer who bought `sso` read `active` while every gated feature
    // refused them. Both facts were on screen (`features` vs `gated`) and nothing joined them, so
    // the one word they actually read said they were fine.
    const report = describeLicense(NOW, env({ [LICENSE_KEY_ENV]: key({ features: ['sso'] }) }));
    expect(report.status).toBe('active');
    expect(report.coversNothingHere).toBe(true);
    expect(report.detail).toMatch(/sso/);
  });

  it('stays quiet when the key does cover something, or covers everything', () => {
    const scoped = describeLicense(
      NOW,
      env({ [LICENSE_KEY_ENV]: key({ features: ['audit-log'] }) }),
    );
    expect(scoped.coversNothingHere).toBeUndefined();
    // No `features` at all means every gated feature is included, which is the common case.
    const unscoped = describeLicense(NOW, env({ [LICENSE_KEY_ENV]: key() }));
    expect(unscoped.coversNothingHere).toBeUndefined();
  });
});

describe('the two gate entry points must agree', () => {
  const PUBKEY_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();

  it('assertEnterprise honours a BAKED issuer key, exactly as the env-resolved gate does', () => {
    // Found on the published 2.10.0 package: same build, same valid key, opposite answers.
    // assertEnterpriseFromEnv ALLOWED and assertEnterprise(ctx) DENIED with `no-issuer-key`,
    // because the ctx path read only the environment and never the key baked at release. The only
    // gated feature calls the ctx path, so on a real release it refused every valid licence, and
    // whatever real feature got gated next would have been dead on arrival for the same reason.
    expect(() =>
      assertEnterprise(
        'audit-log',
        { requireLicense: true, now: () => NOW, key: key() },
        // No env public key: the baked one is the only thing that can resolve here.
        { ...process.env, [LICENSE_PUBLIC_KEY_ENV]: undefined },
        PUBKEY_PEM,
      ),
    ).not.toThrow();
  });

  it('still denies when nothing resolves an issuer key at all', () => {
    expect(() =>
      assertEnterprise(
        'audit-log',
        { requireLicense: true, now: () => NOW, key: key() },
        { ...process.env, [LICENSE_PUBLIC_KEY_ENV]: undefined },
        '',
      ),
    ).toThrow(/no-issuer-key/);
  });
});

describe('what an ACTIVE licence is told about gating', () => {
  const PUBKEY_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const env = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    [LICENSE_PUBLIC_KEY_ENV]: PUBKEY_PEM,
    ...over,
  });

  it('does not list gated features to a customer whose licence already works', () => {
    // `gated` exists so an UNLICENSED reader is not told to set a variable with no idea what it
    // unlocks. A paying customer has already bought; listing feature names at them reveals the
    // product surface for no benefit they need.
    const report = describeLicense(NOW, env({ [LICENSE_KEY_ENV]: key() }));
    expect(report.status).toBe('active');
    expect(report.gated).toBeUndefined();
    expect(report.contact).toBe(LICENSE_CONTACT);
  });

  it('still lists them when the key covers nothing this build gates, because that needs explaining', () => {
    const report = describeLicense(NOW, env({ [LICENSE_KEY_ENV]: key({ features: ['sso'] }) }));
    expect(report.coversNothingHere).toBe(true);
    expect(report.gated).toEqual(Object.values(EnterpriseFeature));
  });

  it('still lists them on every branch a prospective customer lands on', () => {
    for (const report of [
      describeLicense(NOW, {}),
      describeLicense(NOW, env()),
      describeLicense(NOW, env({ [LICENSE_KEY_ENV]: key({ exp: PAST }) })),
      describeLicense(NOW, env({ [LICENSE_KEY_ENV]: 'garbage' })),
    ]) {
      expect(report.gated, `${report.status} lists nothing as gated`).toBeDefined();
    }
  });
});
