import { beforeEach, describe, expect, it } from 'vitest';
import { CompareAs, EngineBlindSpotKind, PredicateKind, type Predicate } from '@reticlehq/core';
import {
  engineBlindSpotsField,
  forgetAllRecordedGaps,
  forgetRecordedGaps,
  notedAct,
} from './recorded-gaps.js';

/**
 * What a hosted run could not observe, carried on every verdict so the host can refuse `clean`.
 *
 * Measured on the fixture suite: the canvas, game and scoreboard builds read `clean` on a broken
 * build, because nothing in the result said the engine never looked at pixels or at the arithmetic
 * the claim states.
 */

const TAB = { id: 'run-1' };
const SCORE_CLAIM = 'Each hit on the target adds one to the score.';
const compare: Predicate = {
  kind: PredicateKind.COMPARE,
  left: { from: PredicateKind.STATE, store: 'game', path: 'score' },
  right: { from: PredicateKind.TEXT, scope: '#score' },
  as: CompareAs.NUMBER,
};
const settled: Predicate = { kind: PredicateKind.SETTLED };

const kinds = (predicate: Predicate, intent?: string): string[] =>
  engineBlindSpotsField(TAB.id, predicate, intent, []).engineBlindSpots.map((s) => s.kind);

beforeEach(() => {
  forgetAllRecordedGaps();
});

describe('engineBlindSpots on a verdict result', () => {
  it('is an empty list when the run hid nothing', () => {
    expect(kinds(settled)).toEqual([]);
  });

  it('names unobserved pixels once an act ran with a canvas on screen, across a reload', () => {
    notedAct(TAB, { ok: true, result: { effect: { canvases: 1 } } });
    forgetRecordedGaps(TAB.id);
    expect(kinds(settled)).toEqual([EngineBlindSpotKind.PIXELS_UNOBSERVED]);
  });

  it('names unchecked arithmetic until a verdict runs a comparison, then stays clear', () => {
    expect(kinds(settled, SCORE_CLAIM)).toEqual([EngineBlindSpotKind.CLAIM_ARITHMETIC_UNCHECKED]);
    expect(kinds(compare, SCORE_CLAIM)).toEqual([]);
    expect(kinds(settled, SCORE_CLAIM)).toEqual([]);
  });

  it("reads the run's declared intents as claims", () => {
    const field = engineBlindSpotsField(TAB.id, settled, undefined, [{ statement: SCORE_CLAIM }]);
    expect(field.engineBlindSpots.map((s) => s.kind)).toEqual([
      EngineBlindSpotKind.CLAIM_ARITHMETIC_UNCHECKED,
    ]);
  });
});
