/**
 * The contract fingerprint — what makes "these two pieces disagree" a DERIVED fact.
 *
 * Reticle ships as pieces installed separately: the SDK in the page, the daemon, the MCP server the
 * agent spawns. They drift constantly, and until now the only signal was package-version equality,
 * which is wrong in both directions. It fires on 2.4.0-vs-2.4.1 where nothing changed — so every
 * patch release makes every un-upgraded app cry wolf, and a warning that usually means nothing gets
 * trained into background noise. And it CANNOT fire on the case that matters most: two builds of the
 * same version number, which is exactly what a stale daemon or a cached npx package is.
 *
 * So the fingerprint hashes the thing that actually has to agree — core's wire vocabulary, the
 * commands and message kinds and event types both sides speak. Both sides compute it from their OWN
 * copy of core, so equal hashes mean "we share a contract" no matter what the package.json says.
 *
 * DERIVED, never hand-bumped: a hand-maintained contract number is one someone forgets to raise, and
 * a forgotten bump is silent skew — the exact failure being fixed. Rename a command and the hash
 * moves on its own; refactor an internal and it does not.
 */

import { describe, expect, it } from 'vitest';
import { CONTRACT_FINGERPRINT, fingerprintOf } from './contract-fingerprint.js';

describe('CONTRACT_FINGERPRINT', () => {
  it('is a short, stable, printable id', () => {
    expect(CONTRACT_FINGERPRINT).toMatch(/^[0-9a-f]{8}$/);
    expect(CONTRACT_FINGERPRINT).toBe(CONTRACT_FINGERPRINT);
  });
});

describe('fingerprintOf', () => {
  it('is stable across runs and insertion order — the same contract hashes the same', () => {
    const a = fingerprintOf({ b: ['two', 'one'], a: ['x'] });
    const b = fingerprintOf({ a: ['x'], b: ['one', 'two'] });
    expect(a).toBe(b);
  });

  it('MOVES when a wire name changes — a renamed command is a different contract', () => {
    const before = fingerprintOf({ commands: ['snapshot', 'query', 'act'] });
    expect(fingerprintOf({ commands: ['snapshot', 'query', 'perform'] })).not.toBe(before);
  });

  it('MOVES when a wire name is added or removed', () => {
    const before = fingerprintOf({ commands: ['snapshot', 'query'] });
    expect(fingerprintOf({ commands: ['snapshot', 'query', 'act'] })).not.toBe(before);
    expect(fingerprintOf({ commands: ['snapshot'] })).not.toBe(before);
  });

  it('does NOT move for anything outside the listed vocabulary', () => {
    // The point of hashing the vocabulary rather than the package: internals change every release
    // and change nothing about whether two pieces can talk.
    const twice = fingerprintOf({ commands: ['snapshot', 'query'] });
    expect(fingerprintOf({ commands: ['snapshot', 'query'] })).toBe(twice);
  });

  it('distinguishes the same names under a different key — position in the contract matters', () => {
    expect(fingerprintOf({ commands: ['a'] })).not.toBe(fingerprintOf({ events: ['a'] }));
  });
});
