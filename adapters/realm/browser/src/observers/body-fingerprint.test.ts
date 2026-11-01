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
