import { describe, expect, it } from 'vitest';
import { errorSkeleton, fingerprintError } from './error-fingerprint.js';

/**
 * An error message is app-authored text. Anything in it that could identify a person or authorise an
 * action must never reach the wire.
 *
 * A telemetry audit captured `bob@acme.com` arriving VERBATIM in `crash_message`. Probing further,
 * the hole was wider than the report: API-key-shaped tokens survived intact and a JWT was only
 * partially masked.
 *
 *   "login failed for bob@acme.com"            -> "login failed for bob@acme.com"
 *   "token sk_live_ABCDEFGHIJKLMNOP rejected"  -> "token sk_live_ABCDEFGHIJKLMNOP rejected"
 *   "Bearer eyJhbGciOiJIUzI1NiJ9.eyJ…"         -> "Bearer eyJhbGciOiJIUzI*NiJ*.eyJ…"
 *
 * This function also feeds `session.errors[]` on EVERY session summary, not just crashes, so the
 * exposure is every session that logged an error naming a user — not a rare crash path.
 *
 * The existing rules were written to make messages GROUPABLE (blank the variable parts so the same
 * defect hashes the same). Redaction was a side effect, and a side effect is not a guarantee.
 */
describe('errorSkeleton redacts what must never leave the machine', () => {
  it.each([
    ['a plain email', 'login failed for bob@acme.com', 'bob@acme.com'],
    [
      'an email with plus-addressing and a multi-part TLD',
      'user alice.smith+test@corp.co.uk not found',
      'alice.smith+test@corp.co.uk',
    ],
    [
      'a stripe-style secret',
      'token sk_live_ABCDEFGHIJKLMNOP rejected',
      'sk_live_ABCDEFGHIJKLMNOP',
    ],
    [
      'a github token',
      'auth ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123 failed',
      'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123',
    ],
    ['an AWS key id', 'denied for AKIAIOSFODNN7EXAMPLE', 'AKIAIOSFODNN7EXAMPLE'],
    [
      'a JWT',
      'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghijklmnop rejected',
      'eyJhbGciOiJIUzI1NiJ9',
    ],
    [
      'an unrecognised long secret',
      'key 9f8e7d6c5b4a39281706abcdEFGH failed',
      '9f8e7d6c5b4a39281706abcdEFGH',
    ],
  ])('removes %s', (_label, message, secret) => {
    expect(errorSkeleton(message)).not.toContain(secret);
  });

  it('still leaves the message groupable — the shape survives', () => {
    // The point of the skeleton is that the SAME defect hashes the same on every machine. Redacting
    // must not turn every message into a row of asterisks.
    const skeleton = errorSkeleton('login failed for bob@acme.com');
    expect(skeleton).toContain('login failed for');
  });

  it('gives two users of the same defect the SAME fingerprint', () => {
    expect(fingerprintError('login failed for bob@acme.com')).toBe(
      fingerprintError('login failed for alice@other.org'),
    );
  });

  it('does not mangle ordinary prose', () => {
    expect(errorSkeleton('no browser session connected')).toBe('no browser session connected');
  });
});
