import { describe, expect, it } from 'vitest';
import { requireAssertion, requireVerdict } from './smoke-checks.mjs';

describe('smoke verdicts require observed evidence', () => {
  it('accepts a true and a false assertion', () => {
    expect(() => requireAssertion({ pass: true, verified: 'yes' }, true)).not.toThrow();
    expect(() => requireAssertion({ pass: false, verified: 'no' }, false)).not.toThrow();
  });
  it.each([
    {},
    { pass: false },
    { pass: false, observationLost: true },
    { pass: false, inconclusive: 'disconnected' },
    { pass: false, verified: 'unknown' },
    { pass: false, verified: 'no-fault' },
    { pass: true },
  ])('never mistakes missing evidence for an observed failure: %j', (result) => {
    expect(() => requireAssertion(result, false)).toThrow();
  });
  it.each(['unknown', 'no-fault', undefined])('rejects an unverified action: %s', (verified) => {
    expect(() => requireVerdict({ verified }, true)).toThrow();
    expect(() => requireVerdict({ verified }, false)).toThrow();
  });
  it('requires opposite verdicts for working and broken controls', () => {
    expect(() => requireVerdict({ verified: 'yes' }, true)).not.toThrow();
    expect(() => requireVerdict({ verified: 'no' }, false)).not.toThrow();
    expect(() => requireVerdict({ verified: 'yes' }, false)).toThrow();
    expect(() => requireVerdict({ verified: 'no' }, true)).toThrow();
  });
});
