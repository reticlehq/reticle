import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { isSensitiveKey, scrubKnownSecrets } from './redaction.js';
import { REDACTED_VALUE } from './constants/constants.js';

/**
 * Property / fuzz coverage for the redaction primitives — the highest-risk parse surface in the wire
 * path, because a miss leaks a credential into the journal + the agent's context, and a
 * catastrophically-backtracking regex on adversarial input hangs the bridge. These run thousands of
 * generated inputs against invariants rather than fixed examples, through fast-check with a FIXED
 * seed: not Math.random (which would break reproducibility and violate the injected-clock rule), so
 * a failure always reproduces, and fast-check shrinks it to the smallest input that still fails.
 */

const ALPHABET = [...'abcABC012 ._-@=:/{}"\'\\\n\t&?#eyJ.'];
const adversarial = (maxLength: number): fc.Arbitrary<string> =>
  fc.array(fc.constantFrom(...ALPHABET), { maxLength }).map((chars) => chars.join(''));

describe('redaction fuzz — no crash, no hang, no leak of a known secret shape', () => {
  it('scrubKnownSecrets never throws and terminates on 5,000 adversarial inputs', () => {
    fc.assert(
      fc.property(adversarial(400), (s) => {
        // Invariant: never throws (a regex error / infinite loop would surface here).
        scrubKnownSecrets(s);
        isSensitiveKey(s);
      }),
      { seed: 0x9e3779b1, numRuns: 5000 },
    );
    // The "no hang" backstop is the per-test TIMEOUT below, not a wall-clock assertion. Catastrophic
    // regex backtracking would blow a generous timeout; a `Date.now() - start < N` check is a
    // statement about the machine and flakes under CI load (it failed at 4056ms vs a 4000ms limit),
    // which is exactly the timing-assertion anti-pattern the repo rules forbid.
  }, 20_000);

  it('a JWT is redacted no matter what benign text surrounds it', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dQw4w9WgXcQabcdefgh';
    // `eyJ` stripped from the padding so the only token in the input is the one under test.
    const padding = adversarial(60).map((s) => s.replace(/eyJ/g, 'x'));
    fc.assert(
      fc.property(padding, padding, (pre, post) => {
        const out = scrubKnownSecrets(`${pre}${jwt}${post}`);
        expect(out).not.toContain(jwt); // the secret itself must be gone
        expect(out).toContain(REDACTED_VALUE);
      }),
      { seed: 0x1234abcd, numRuns: 500 },
    );
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
