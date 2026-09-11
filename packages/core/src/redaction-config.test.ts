import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildRedactionPolicy,
  defaultIsSensitiveKey,
  isSensitiveKey,
  resetActiveRedactionPolicy,
  setActiveRedactionPolicy,
  wireRedactionKeys,
} from './redaction.js';

afterEach(() => {
  resetActiveRedactionPolicy();
});

describe('the default rule is untouched by the feature existing', () => {
  // The regression this whole feature could become: a configurable rule whose UNCONFIGURED behaviour
  // drifts from the hardcoded one it replaced. Every credential-shaped key the old regex caught must
  // still be caught, and every false-positive it was deliberately taught to allow must still pass.
  const CREDENTIALS = [
    'password',
    'passwd',
    'secret',
    'accessToken',
    'auth_token',
    'sessionToken',
    'token',
    'tokens',
    'session_id',
    'jwt',
    'authorization',
    'cookie',
    'set-cookie',
    'api_key',
    'private_key',
    'client_secret',
    'creditCard',
    'cvv',
    'ssn',
  ];
  const LEGITIMATE = [
    'colorToken',
    'backgroundToken',
    'tokenCount',
    'designToken',
    'scopecookie',
    'cookieConsent',
    'cookiePolicy',
    'username',
    'email',
  ];

  it.each(CREDENTIALS)('still redacts %s with no config', (key) => {
    expect(isSensitiveKey(key)).toBe(true);
    expect(buildRedactionPolicy().isSensitiveKey(key)).toBe(true);
  });

  it.each(LEGITIMATE)('still leaves %s visible with no config', (key) => {
    expect(isSensitiveKey(key)).toBe(false);
    expect(buildRedactionPolicy().isSensitiveKey(key)).toBe(false);
  });

  it('an empty config is the default policy, not a different one', () => {
    const policy = buildRedactionPolicy({});
    for (const key of [...CREDENTIALS, ...LEGITIMATE]) {
      expect(policy.isSensitiveKey(key)).toBe(defaultIsSensitiveKey(key));
    }
  });
});

describe('redact.keys — the app declares its own credentials', () => {
  it('redacts an app-specific key the default rule has never heard of', () => {
    const policy = buildRedactionPolicy({ keys: ['licenceKey'] });
    expect(defaultIsSensitiveKey('licenceKey')).toBe(false);
    expect(policy.isSensitiveKey('licenceKey')).toBe(true);
  });

  it('matches a declared key case-insensitively, because wire keys are not normalized', () => {
    const policy = buildRedactionPolicy({ keys: ['partnerCode'] });
    expect(policy.isSensitiveKey('partnercode')).toBe(true);
    expect(policy.isSensitiveKey('PARTNERCODE')).toBe(true);
  });

  it('matches a declared string EXACTLY, so it cannot silently over-redact a neighbour', () => {
    const policy = buildRedactionPolicy({ keys: ['code'] });
    expect(policy.isSensitiveKey('code')).toBe(true);
    expect(policy.isSensitiveKey('codeOwner')).toBe(false);
    expect(policy.isSensitiveKey('postcode')).toBe(false);
  });

  it('accepts a RegExp for the cases an exact name cannot express', () => {
    const policy = buildRedactionPolicy({ keys: [/^partner[-_]?code$/i] });
    expect(policy.isSensitiveKey('partner_code')).toBe(true);
    expect(policy.isSensitiveKey('partner-code')).toBe(true);
    expect(policy.isSensitiveKey('partnerCode')).toBe(true);
    expect(policy.isSensitiveKey('partnerCodes')).toBe(false);
  });

  it('is additive — the default rule keeps working alongside it', () => {
    const policy = buildRedactionPolicy({ keys: ['partnerCode'] });
    expect(policy.isSensitiveKey('password')).toBe(true);
  });
});

describe('redact.allow — the app un-redacts its own false positives', () => {
  it('exempts a key the default rule matched', () => {
    const policy = buildRedactionPolicy({ allow: ['session_id'] });
    expect(defaultIsSensitiveKey('session_id')).toBe(true);
    expect(policy.isSensitiveKey('session_id')).toBe(false);
  });

  it('exempts case-insensitively', () => {
    const policy = buildRedactionPolicy({ allow: ['sessionToken'] });
    expect(policy.isSensitiveKey('SESSIONTOKEN')).toBe(false);
  });

  it('leaves every other key alone', () => {
    const policy = buildRedactionPolicy({ allow: ['session_id'] });
    expect(policy.isSensitiveKey('password')).toBe(true);
  });

  it('loses to keys — an explicit redact instruction beats an exemption', () => {
    const policy = buildRedactionPolicy({ keys: ['weird'], allow: ['weird'] });
    expect(policy.isSensitiveKey('weird')).toBe(true);
  });
});

describe('the allow foot-gun announces itself', () => {
  it('warns ONCE, naming the key, when an exemption un-redacts a credential', () => {
    const warn = vi.fn();
    buildRedactionPolicy({ allow: ['password', 'designToken'] }, warn);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('password');
    // A key the default rule never matched is not a foot-gun — it is the false-positive fix this
    // option exists for, and warning about it would train people to ignore the real warning.
    expect(warn.mock.calls[0]?.[0]).not.toContain('designToken');
  });

  it('says nothing when no exemption touches a credential', () => {
    const warn = vi.fn();
    buildRedactionPolicy({ allow: ['designToken'], keys: ['partnerCode'] }, warn);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns at BUILD time, not per key, so a hot path cannot be flooded', () => {
    const warn = vi.fn();
    const policy = buildRedactionPolicy({ allow: ['password'] }, warn);
    for (let i = 0; i < 100; i++) policy.isSensitiveKey('password');
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('the ambient policy — set once at connect, read by every existing call site', () => {
  it('isSensitiveKey follows the active policy', () => {
    expect(isSensitiveKey('partnerCode')).toBe(false);
    setActiveRedactionPolicy(buildRedactionPolicy({ keys: ['partnerCode'] }));
    expect(isSensitiveKey('partnerCode')).toBe(true);
  });

  it('reset restores the default rule exactly', () => {
    setActiveRedactionPolicy(buildRedactionPolicy({ allow: ['password'] }));
    expect(isSensitiveKey('password')).toBe(false);
    resetActiveRedactionPolicy();
    expect(isSensitiveKey('password')).toBe(true);
  });

  it('defaultIsSensitiveKey ignores the active policy — the driven path needs an unconfigurable floor', () => {
    setActiveRedactionPolicy(buildRedactionPolicy({ allow: ['password'] }));
    expect(defaultIsSensitiveKey('password')).toBe(true);
  });
});

describe('wireRedactionKeys — what may cross the bridge', () => {
  it('carries literal key names, so the server redacts them on the driven path too', () => {
    expect(wireRedactionKeys({ keys: ['licenceKey', 'partnerCode'] })).toEqual([
      'licenceKey',
      'partnerCode',
    ]);
  });

  it('drops RegExp entries — a pattern compiled from the wire is a ReDoS surface', () => {
    expect(wireRedactionKeys({ keys: ['literal', /^pattern$/] })).toEqual(['literal']);
  });

  it('never carries allow — an exemption arriving from the page could only ever REMOVE redaction', () => {
    expect(wireRedactionKeys({ allow: ['password'] })).toEqual([]);
  });

  it('is empty for no config, so a default session adds nothing to the wire', () => {
    expect(wireRedactionKeys()).toEqual([]);
    expect(wireRedactionKeys({})).toEqual([]);
  });

  it('de-duplicates and drops empties, so a sloppy config cannot bloat every hello', () => {
    expect(wireRedactionKeys({ keys: ['a', 'a', '', '  ', 'b'] })).toEqual(['a', 'b']);
  });
});
