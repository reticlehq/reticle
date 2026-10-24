import { describe, expect, it } from 'vitest';
import { CompareAs, type CompareSource } from './compare-source.js';
import { PredicateKind } from './consequence.js';
import type { Predicate } from './predicate.js';
import { computesComparison } from './predicate-tree.js';
import {
  EngineBlindSpotKind,
  EngineBlindSpotSchema,
  engineBlindSpots,
  namesArithmetic,
} from './instrumentation-gap.js';

const SCORE_CLAIM = 'Each hit on the target adds one to the score.';
const left: CompareSource = { from: PredicateKind.STATE, store: 'game', path: 'score' };
const right: CompareSource = { from: PredicateKind.TEXT, scope: '#score' };
const compare: Predicate = { kind: PredicateKind.COMPARE, left, right, as: CompareAs.NUMBER };
const kinds = (facts: Parameters<typeof engineBlindSpots>[0]): string[] =>
  engineBlindSpots(facts).map((s) => s.kind);

describe('the engine blind-spot contract', () => {
  it('accepts each kind with a detail and refuses an unknown kind', () => {
    for (const kind of Object.values(EngineBlindSpotKind)) {
      expect(EngineBlindSpotSchema.safeParse({ kind, detail: 'x' }).success).toBe(true);
    }
    expect(EngineBlindSpotSchema.safeParse({ kind: 'other', detail: 'x' }).success).toBe(false);
  });
});

describe('namesArithmetic', () => {
  it('reads an amount stated in digits, words or arithmetic nouns', () => {
    expect(namesArithmetic('Each hit on the target adds one to the score.')).toBe(true);
    expect(namesArithmetic('A win is worth 3 points.')).toBe(true);
    expect(namesArithmetic('The cart total updates when an item is removed.')).toBe(true);
  });

  it('does not read a claim with no amount in it', () => {
    expect(namesArithmetic('Choosing a colour recolours what is drawn.')).toBe(false);
    // Whole words only: "account" and "someone" hold no amount.
    expect(namesArithmetic('Someone can open their account settings.')).toBe(false);
  });
});

describe('engineBlindSpots', () => {
  it('names unobserved pixels once a canvas was visible during an action', () => {
    expect(kinds({ canvasSeen: true, compared: false, claims: [] })).toEqual([
      EngineBlindSpotKind.PIXELS_UNOBSERVED,
    ]);
  });

  it('names unchecked arithmetic for a numeric claim with no computed comparison', () => {
    expect(kinds({ canvasSeen: false, compared: false, claims: [undefined, SCORE_CLAIM] })).toEqual(
      [EngineBlindSpotKind.CLAIM_ARITHMETIC_UNCHECKED],
    );
  });

  it('is empty once a comparison ran, and for a claim with no amount', () => {
    expect(kinds({ canvasSeen: false, compared: true, claims: [SCORE_CLAIM] })).toEqual([]);
    expect(kinds({ canvasSeen: false, compared: false, claims: ['The menu opens.'] })).toEqual([]);
  });
});

describe('computesComparison', () => {
  it('finds a compare at any depth', () => {
    expect(computesComparison(compare)).toBe(true);
    const nested: Predicate = {
      kind: PredicateKind.ALL_OF,
      predicates: [{ kind: PredicateKind.NOT, predicate: compare }],
    };
    expect(computesComparison(nested)).toBe(true);
    expect(computesComparison({ kind: PredicateKind.SETTLED })).toBe(false);
    expect(computesComparison(undefined)).toBe(false);
  });
});
