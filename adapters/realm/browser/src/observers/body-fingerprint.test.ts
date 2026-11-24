import { describe, expect, it, vi } from 'vitest';

/**
 * The salt is the whole privacy argument of the text-body fingerprint (#1521): the hash
 * covers the body's values, so a reader who guesses a short value must not be able to
 * confirm the guess from a recorded fingerprint. These tests pin the salt itself. On the
 * code before this change there was no salted fingerprint at all, and the shape hash they
 * replace is reproducible from the payload alone, so they fail there.
 */
describe('fingerprintTextBody', () => {
  it('gives equal bodies one fingerprint and different values different ones', async () => {
    const { fingerprintTextBody } = await import('./body-fingerprint.js');
    const body = JSON.stringify({ cmd: 'save', name: 'ada' });
    expect(fingerprintTextBody(body)).toBe(fingerprintTextBody(body));
    expect(fingerprintTextBody(body)).not.toBe(
      fingerprintTextBody(JSON.stringify({ cmd: 'save', name: 'eve' })),
    );
  });

  it('separates two sends that differ only in a timestamp or a request id', async () => {
    // The accuracy trade the maintainer asked to see stated (reviews of 2026-11-11 and
    // 2026-11-23): a double submit whose second send carries a fresh client timestamp,
    // request id or idempotency key is NOT reported as a duplicate, because every value
    // is part of the fingerprint. It is not a pass either: the two sends share a shape
    // fingerprint, and the engine reports that pair as calls it could not tell apart
    // (`duplicate-request-indistinguishable`, pinned in the engine tests). Before this
    // change the shape fingerprint alone grouped the two sends as one write fired twice.
    const { fingerprintTextBody } = await import('./body-fingerprint.js');
    const first = JSON.stringify({ cmd: 'save', ts: 1731415200000, requestId: 'req-1' });
    const second = JSON.stringify({ cmd: 'save', ts: 1731415200500, requestId: 'req-2' });
    expect(fingerprintTextBody(first)).not.toBe(fingerprintTextBody(second));
    expect(fingerprintTextBody(first)).toBe(fingerprintTextBody(first));
  });

  it('separates FormData text values that share a length, and groups equal forms', async () => {
    const { fingerprintFormBody } = await import('./body-fingerprint.js');
    const form = (cmd: string): FormData => {
      const f = new FormData();
      f.append('cmd', cmd);
      return f;
    };
    // The issue's own example through the FormData path: accessSets and currencies have
    // the same length, so the sum-of-lengths shape grouped them as one write.
    expect(fingerprintFormBody(form('accessSets'))).not.toBe(
      fingerprintFormBody(form('currencies')),
    );
    expect(fingerprintFormBody(form('accessSets'))).toBe(fingerprintFormBody(form('accessSets')));
    const empty = new FormData();
    expect(fingerprintFormBody(empty)).toBeUndefined();
  });

  it('cannot be reproduced from the payload without the page salt', async () => {
    vi.resetModules();
    const first = await import('./body-fingerprint.js');
    const body = JSON.stringify({ email: 'a@b.com', password: 'req-pass-abcdef123' });
    const recorded = first.fingerprintTextBody(body);
    // A fresh page load draws a fresh salt, so the same body records a different
    // fingerprint. A journal reader holds only recorded fingerprints: with no salt, the
    // hash of a guessed payload would match the record and confirm the guess.
    vi.resetModules();
    const second = await import('./body-fingerprint.js');
    expect(second.fingerprintTextBody(body)).not.toBe(recorded);
    expect(second.fingerprintTextBody(body)).toBe(second.fingerprintTextBody(body));
  });
});
