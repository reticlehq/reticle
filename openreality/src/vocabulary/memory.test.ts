import { describe, expect, it } from 'vitest';
import { beliefCanProve, promoteBelief, strongestVerdictFrom, type Belief } from './memory.js';
import { ProvenanceClass } from './evidence.js';
import { Verdict } from './verdict.js';

/**
 * The fence around learned belief.
 *
 * This is the test that decides whether putting memory in the protocol was a good idea. A
 * verification system that learns what normal looks like and then treats normal as correct has
 * become an expensive way of confirming that yesterday happened again — the standard failure of
 * every invariant miner since Daikon, and one an anti-false-green protocol cannot survive.
 *
 * The fence is that a learned belief can never, by itself, produce a `yes`. These tests are the
 * fence; without them the rule is a paragraph.
 */

const learned: Belief = {
  id: 'b1',
  kind: 'invariant',
  statement: 'checkout always emits order:created within 2s',
  provenance: {
    class: ProvenanceClass.LEARNED,
    source: 'miner',
    method: 'observed 4,000 times',
    subject: { surface: 'web', instance: 'i1' },
    at: 1,
    confidence: 0.999,
  },
  observations: 4000,
};

describe('a learned belief cannot prove anything on its own', () => {
  it('refuses no matter how many observations back it', () => {
    expect(beliefCanProve(learned)).toBe(false);
    expect(beliefCanProve({ ...learned, observations: 10_000_000 })).toBe(false);
  });

  it('refuses no matter how high the confidence', () => {
    // A threshold is a number somebody picked. If crossing one were enough, the fence would be a
    // comment and the only question would be who picked the number.
    expect(
      beliefCanProve({
        ...learned,
        provenance: { ...learned.provenance, confidence: 1 },
      }),
    ).toBe(false);
  });

  it('answers a violation with unknown, which sends somebody to look', () => {
    // Not `no`. A suspicion that fires is a reason to gather evidence, never a finding — and the
    // difference decides whether a team goes and fixes something that may not be broken.
    expect(strongestVerdictFrom(learned)).toBe(Verdict.UNKNOWN);
  });

  it('lets an authoritative belief convict', () => {
    const stated: Belief = {
      ...learned,
      provenance: { ...learned.provenance, class: ProvenanceClass.AUTHORITATIVE },
    };
    expect(beliefCanProve(stated)).toBe(true);
    expect(strongestVerdictFrom(stated)).toBe(Verdict.NO);
  });
});

describe('the only route out of learned is a named promotion', () => {
  it('records who promoted it and when', () => {
    const promoted = promoteBelief(learned, 'a.reviewer', 99);
    expect(promoted.provenance.class).toBe(ProvenanceClass.AUTHORITATIVE);
    expect(promoted.promotedBy).toBe('a.reviewer');
    expect(beliefCanProve(promoted)).toBe(true);
  });

  it('refuses an anonymous promotion', () => {
    // The automated version of promotion is the thing the fence exists to prevent, and an
    // anonymous promotion is what the automated version looks like.
    expect(() => promoteBelief(learned, '   ', 99)).toThrow(/can be named/);
  });

  it('leaves the original untouched, so the ledger shows the belief was ever only learned', () => {
    const promoted = promoteBelief(learned, 'a.reviewer', 99);
    expect(learned.provenance.class).toBe(ProvenanceClass.LEARNED);
    expect(promoted).not.toBe(learned);
  });
});
