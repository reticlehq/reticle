import { describe, expect, it } from 'vitest';
import { satisfiesProperty } from './property.js';

/**
 * Asserting a PROPERTY of a value rather than its exact bytes.
 *
 * Every predicate this engine had compared for equality, which cannot express the one thing a
 * generative feature needs: an app whose output IS a model's output is different on every run and
 * correct on every one of them. "The summary equals 'Paris is the capital'" fails the next run for
 * the right answer; "the summary is a non-empty string that mentions Paris" holds.
 *
 * The discipline that has to survive is DETERMINISM. A schema check, a tolerance, a membership
 * test and a pattern match are all decidable by this function alone, with no model in the loop and
 * no network call. "Ask a model whether it looks right" is not, and it would make the verdict
 * unfalsifiable — which is the exact failure `no-fault` exists to name rather than paper over.
 */
describe('satisfiesProperty', () => {
  describe('nonEmpty — the model produced SOMETHING', () => {
    it('holds for a non-empty string, array or object', () => {
      expect(satisfiesProperty('a summary', { property: 'nonEmpty' }).ok).toBe(true);
      expect(satisfiesProperty([1], { property: 'nonEmpty' }).ok).toBe(true);
      expect(satisfiesProperty({ a: 1 }, { property: 'nonEmpty' }).ok).toBe(true);
    });
    it('fails for empty, whitespace, null and undefined — the real failure modes', () => {
      for (const v of ['', '   ', [], {}, null, undefined]) {
        expect(satisfiesProperty(v, { property: 'nonEmpty' }).ok, JSON.stringify(v)).toBe(false);
      }
    });
  });

  describe('oneOf — a classification landed in the allowed set', () => {
    it('holds for a member and fails for anything else', () => {
      const p = { property: 'oneOf', values: ['positive', 'neutral', 'negative'] } as const;
      expect(satisfiesProperty('neutral', p).ok).toBe(true);
      expect(satisfiesProperty('NEUTRAL', p).ok).toBe(false);
      expect(satisfiesProperty('confused', p).ok).toBe(false);
    });
  });

  describe('withinTolerance — a number near enough', () => {
    const p = { property: 'withinTolerance', of: 100, tolerance: 5 } as const;
    it('holds on and inside the bound, fails outside it', () => {
      expect(satisfiesProperty(100, p).ok).toBe(true);
      expect(satisfiesProperty(105, p).ok).toBe(true);
      expect(satisfiesProperty(95, p).ok).toBe(true);
      expect(satisfiesProperty(105.01, p).ok).toBe(false);
    });
    it('fails a non-number rather than coercing it — "100" is not 100', () => {
      expect(satisfiesProperty('100', p).ok).toBe(false);
      expect(satisfiesProperty(Number.NaN, p).ok).toBe(false);
    });
  });

  describe('matchesPattern — the shape of the output', () => {
    it('holds when the pattern matches the string form', () => {
      expect(
        satisfiesProperty('order-4821', { property: 'matchesPattern', pattern: '^order-\\d+$' }).ok,
      ).toBe(true);
      expect(
        satisfiesProperty('order-x', { property: 'matchesPattern', pattern: '^order-\\d+$' }).ok,
      ).toBe(false);
    });
    it('REFUSES an invalid pattern instead of passing or throwing', () => {
      // A pattern that cannot compile must not read as "no match" — that is a broken check reported
      // as a real negative, which is the false-green shape in miniature.
      const r = satisfiesProperty('x', { property: 'matchesPattern', pattern: '([' });
      expect(r.ok).toBe(false);
      expect(r.because).toMatch(/not a valid/i);
    });
  });

  describe('type — the output is the right KIND of thing', () => {
    it('distinguishes array from object, which typeof cannot', () => {
      expect(satisfiesProperty([1, 2], { property: 'type', is: 'array' }).ok).toBe(true);
      expect(satisfiesProperty({ a: 1 }, { property: 'type', is: 'array' }).ok).toBe(false);
      expect(satisfiesProperty({ a: 1 }, { property: 'type', is: 'object' }).ok).toBe(true);
      expect(satisfiesProperty([1], { property: 'type', is: 'object' }).ok).toBe(false);
    });
    it('does not count null as an object', () => {
      expect(satisfiesProperty(null, { property: 'type', is: 'object' }).ok).toBe(false);
    });
  });

  it('always says WHY, so a failure is actionable without a second call', () => {
    const r = satisfiesProperty('', { property: 'nonEmpty' });
    expect(r.ok).toBe(false);
    expect(r.because.length).toBeGreaterThan(10);
  });
});
