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

  it('gives two users of the same defect the SAME fingerprint', () => {
    expect(fingerprintError('login failed for bob@acme.com')).toBe(
      fingerprintError('login failed for alice@other.org'),
    );
  });

  it('does not mangle ordinary prose', () => {
    expect(errorSkeleton('no browser session connected')).toBe('no browser session connected');
  });
});

/**
 * The ReDoS, and why this asserts a BOUND rather than a duration.
 *
 * CodeQL flagged `errorSkeleton` `high`: `[\w.+-]+@` retries from every start position on a run of
 * `+` with no `@`, so the cost is quadratic in the run's length. The input is an error message,
 * which comes from the page under test — somebody's app, and the most attacker-influenceable string
 * this daemon handles.
 *
 * `Date.now() - t < N` is banned here for good reason: it is a statement about the machine and
 * fails only under parallel load, which is to say only in CI. So the assertions below are about the
 * bound — the output is capped, the shape survives — and the RUNNER's own timeout is what catches a
 * hang. Without the input cap these cases take quadratic time in the input, and the size is chosen
 * from a MEASUREMENT rather than a guess: at 60,000 characters the uncapped version took 1.7s and
 * the test passed, which made it a check that could not fail. At 400,000 it runs past vitest's
 * default timeout, so removing the cap turns this red.
 */
describe('a hostile error message cannot make the skeleton expensive', () => {
  it('bounds a long run of the character that makes the email pattern backtrack', () => {
    const hostile = `${'+'.repeat(400_000)} no match here`;
    const skeleton = errorSkeleton(hostile);
    expect(skeleton.length).toBeLessThanOrEqual(200);
  });

  it('bounds the other two polynomial shapes as well', () => {
    // `(?:\/[\w.-]+){2,}` on a run of slashes, and the 24-plus secret catch-all on a long word.
    expect(errorSkeleton('/'.repeat(400_000)).length).toBeLessThanOrEqual(200);
    expect(errorSkeleton('a'.repeat(400_000)).length).toBeLessThanOrEqual(200);
  });

  it('still redacts a secret that sits inside the part it does read', () => {
    // The cap must not become a way to smuggle something past the redaction: anything beyond it is
    // DROPPED rather than passed through, and anything inside it is masked as before.
    // Shaped to trip the `(?:sk|pk|rk|ghp|…)[_-][A-Za-z0-9_-]{8,}` rule and NOTHING else. The first
    // version read `sk_live_` + lowercase, which is Stripe's live-key format closely enough that
    // GitHub's push protection rejected the push. A fixture that cannot be pushed is not a fixture.
    const secret = 'sk-EXAMPLE-not-a-real-key-000000';
    expect(errorSkeleton(`auth failed with ${secret}`)).not.toContain(secret);
  });

  it('is unchanged for a message shorter than the cap', () => {
    expect(errorSkeleton('no browser session connected')).toBe('no browser session connected');
  });
});

/**
 * Redaction by deny-list cannot win: a hostname, a Windows home directory with a space in it, a
 * `~` path and a person's name in free text all walked through the old rules. So the message is
 * ALLOW-listed now: it survives only as a sentence Reticle itself authors, or as the bare error
 * code, and everything else is replaced by its fingerprint.
 */
describe('errorSkeleton sends only what Reticle wrote', () => {
  it.each([
    ['a hostname', 'getaddrinfo ENOTFOUND db.internal.acmecorp.com', 'acmecorp'],
    ['a Windows path with a space', "ENOENT: open 'C:\\Users\\Jane Doe\\code\\app.ts'", 'Doe'],
    [
      'an unquoted Windows path with a space',
      'cannot read C:\\Users\\Jane Doe\\code\\app.ts',
      'Doe',
    ],
    ['a home-relative path', 'cannot read ~/secret/plans.txt', 'secret'],
    ['a person named in free text', 'login failed for John Smith', 'Smith'],
    ['free text with no variable part at all', 'order for customer Acme Ltd was rejected', 'Acme'],
    ['an IP address', 'connect ECONNREFUSED 10.1.2.3:5432', '10.1.2.3'],
    ['a URL with a query', 'fetch https://api.acme.io/v1/users?email=x failed', 'acme'],
    ['an email', 'no account for bob@acme.com', 'bob'],
  ])('removes %s', (_label, message, leak) => {
    const out = errorSkeleton(message);
    expect(out).not.toContain(leak);
    expect(out, 'still groupable: the fingerprint rides in its place').toMatch(/#[0-9a-f]{12}$/);
  });

  it.each([
    ['getaddrinfo ENOTFOUND db.internal.acmecorp.com', 'ENOTFOUND'],
    ['connect ECONNREFUSED 127.0.0.1:4400', 'ECONNREFUSED'],
    ['write EPIPE', 'EPIPE'],
    ["TypeError: Cannot read properties of undefined (reading 'x')", 'TypeError'],
  ])('keeps the error code of %s', (message, code) => {
    expect(errorSkeleton(message).startsWith(`${code} #`)).toBe(true);
  });

  it.each([
    ["no baseline named 'checkout-v3'", 'no baseline named *'],
    ['no browser session connected. Two things to check: ...', 'no browser session connected'],
    ["ref 'e12' no longer resolves to an element", 'ref * no longer resolves to an element'],
    ['session disconnected', 'session disconnected'],
    [
      'multiple sessions connected — pass sessionId to target one: a, b',
      'multiple sessions connected',
    ],
  ])('keeps the Reticle-authored message %s', (message, expected) => {
    expect(errorSkeleton(message)).toBe(expected);
  });

  it('groups the same unknown defect across machines', () => {
    expect(fingerprintError('getaddrinfo ENOTFOUND db.a.com')).toBe(
      fingerprintError('getaddrinfo ENOTFOUND cache.b.org'),
    );
  });
});
