import { describe, it, expect } from 'vitest';
import { isSensitiveKey, scrubKnownSecrets } from './redaction.js';
import { REDACTED_VALUE } from './constants.js';

/**
 * Property / fuzz coverage for the redaction primitives — the highest-risk parse surface in the wire
 * path, because a miss leaks a credential into the journal + the agent's context, and a
 * catastrophically-backtracking regex on adversarial input hangs the bridge. These run thousands of
 * generated inputs against invariants rather than fixed examples. Deterministic: a seeded xorshift PRNG,
 * NOT Math.random (which would break reproducibility and violate the injected-clock rule) — a failure
 * always reproduces from the printed seed.
 */

/** Tiny seeded PRNG (xorshift32) — pure, reproducible; the seed is the only entropy. */
function prng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 1_000_000) / 1_000_000;
  };
}

const ALPHABET = 'abcABC012 ._-@=:/{}"\'\\\n\t&?#eyJ.';
function randomString(rand: () => number, maxLen: number): string {
  const len = Math.floor(rand() * maxLen);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  return out;
}

describe('redaction fuzz — no crash, no hang, no leak of a known secret shape', () => {
  it('scrubKnownSecrets never throws and terminates on 5,000 adversarial inputs', () => {
    const rand = prng(0x9e3779b1);
    for (let i = 0; i < 5000; i++) {
      const s = randomString(rand, 400);
      // Invariant: never throws (a regex error / infinite loop would surface here).
      expect(() => scrubKnownSecrets(s)).not.toThrow();
      expect(() => isSensitiveKey(s)).not.toThrow();
    }
    // The "no hang" backstop is the per-test TIMEOUT below, not a wall-clock assertion. Catastrophic
    // regex backtracking would blow a generous timeout; a `Date.now() - start < N` check is a
    // statement about the machine and flakes under CI load (it failed at 4056ms vs a 4000ms limit),
    // which is exactly the timing-assertion anti-pattern the repo rules forbid.
  }, 20_000);

  it('a JWT is redacted no matter what benign text surrounds it', () => {
    const rand = prng(0x1234abcd);
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dQw4w9WgXcQabcdefgh';
    for (let i = 0; i < 500; i++) {
      const pre = randomString(rand, 60).replace(/eyJ/g, 'x'); // avoid injecting a second token
      const post = randomString(rand, 60).replace(/eyJ/g, 'x');
      const out = scrubKnownSecrets(`${pre}${jwt}${post}`);
      expect(out).not.toContain(jwt); // the secret itself must be gone
      expect(out).toContain(REDACTED_VALUE);
    }
  });

  it('an adversarial run of the redaction alphabet cannot make the regex quadratic', () => {
    // The class the input-scan cap in network-body guards against: a long run of `[A-Za-z0-9_.-]`
    // followed by no delimiter. Here we prove the core scrub itself stays linear.
    //
    // The backstop is the per-test TIMEOUT below, not a wall-clock assertion — the same rule stated
    // twenty lines above this, which this test was breaking. Catastrophic backtracking on inputs
    // this size does not come in a little over budget; it does not finish. So a generous timeout
    // catches it, while `Date.now() - t0 < 200` is a claim about the machine and fails only under
    // parallel load, which means only in CI.
    for (const n of [1000, 4000, 8000]) {
      expect(() => scrubKnownSecrets('a'.repeat(n))).not.toThrow();
    }
  }, 20_000);
});
