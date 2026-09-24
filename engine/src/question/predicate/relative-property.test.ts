/**
 * Relative properties: the predicate language's past tense.
 *
 * Every leaf in the grammar read the present tense — the DOM now, the store now, the events since a
 * cursor — so the assertions that catch money bugs could not be written at all: the balance went
 * down by what was charged, the list gained three rows, this field held its value across the
 * re-render. Each is a claim about two readings and a subtraction, which keeps it inside the rule
 * `satisfiesProperty` has always held: decided by this function alone, no model, no network, no
 * clock.
 *
 * The comparison vocabulary is the protocol's own `MeasureOp` — three operators and a tolerance on
 * all of them, so "exactly 16", "37 ± 0.5" and "at least 8, and I will accept 7.9" are one shape.
 * A second spelling of an idea the protocol already published is the drift this release is ending.
 */

import { describe, expect, it } from 'vitest';
import { MeasureOp } from 'open-verification';
import { satisfiesProperty } from './property.js';

const before = (value: unknown): { readonly taken: true; readonly value: unknown } => ({
  taken: true,
  value,
});

describe('changed / unchanged — the weakest and most useful', () => {
  it('unchanged holds when the reading is the one it was', () => {
    expect(satisfiesProperty('v2.4.0', { property: 'unchanged' }, before('v2.4.0')).ok).toBe(true);
  });

  // The silently-cleared field: the form re-rendered and took the value with it.
  it('unchanged fails when the value was wiped, and says both readings', () => {
    const r = satisfiesProperty('', { property: 'unchanged' }, before('v2.4.0'));
    expect(r.ok).toBe(false);
    expect(r.because).toContain('v2.4.0');
  });

  it('changed is the mirror', () => {
    expect(satisfiesProperty('b', { property: 'changed' }, before('a')).ok).toBe(true);
    expect(satisfiesProperty('a', { property: 'changed' }, before('a')).ok).toBe(false);
  });

  it('compares structurally, so an equal object is not a change', () => {
    expect(satisfiesProperty({ n: 1 }, { property: 'unchanged' }, before({ n: 1 })).ok).toBe(true);
    expect(satisfiesProperty({ n: 2 }, { property: 'changed' }, before({ n: 1 })).ok).toBe(true);
  });
});

describe('increased / decreased — with an optional delta', () => {
  it('increased holds for any rise when no delta is named', () => {
    expect(satisfiesProperty(4, { property: 'increased' }, before(3)).ok).toBe(true);
    expect(satisfiesProperty(3, { property: 'increased' }, before(3)).ok).toBe(false);
    expect(satisfiesProperty(2, { property: 'increased' }, before(3)).ok).toBe(false);
  });

  it('decreased BY exactly the amount charged', () => {
    const by = { property: 'decreased', by: { op: MeasureOp.EQUALS, value: 12 } } as const;
    expect(satisfiesProperty(88, by, before(100)).ok).toBe(true);
    expect(satisfiesProperty(89, by, before(100)).ok).toBe(false);
  });

  /*
   * `100 - 88.13` is 11.870000000000005. An exact money assertion therefore misses by 5e-15 and
   * would read as the app charging the wrong amount — the single most expensive wrong answer this
   * feature could give. The tolerance is the fix, and the protocol already carries it, so the
   * engine must NOT invent a silent epsilon and disagree with the vocabulary it borrowed. What it
   * owes the reader instead is the sentence that names the trap.
   */
  it('names floating point when an exact delta misses by a rounding error', () => {
    const r = satisfiesProperty(
      88.13,
      { property: 'decreased', by: { op: MeasureOp.EQUALS, value: 11.87 } },
      before(100),
    );
    expect(r.ok).toBe(false);
    expect(r.because).toContain('tolerance');
  });

  it('carries the protocol tolerance, so floating point is not a failure', () => {
    const by = {
      property: 'decreased',
      by: { op: MeasureOp.EQUALS, value: 11.87, tolerance: 0.01 },
    } as const;
    expect(satisfiesProperty(88.14, by, before(100)).ok).toBe(true);
  });

  it('at-least and at-most bound the delta', () => {
    expect(
      satisfiesProperty(
        6,
        { property: 'increased', by: { op: MeasureOp.AT_LEAST, value: 3 } },
        before(3),
      ).ok,
    ).toBe(true);
    expect(
      satisfiesProperty(
        5,
        { property: 'increased', by: { op: MeasureOp.AT_LEAST, value: 3 } },
        before(3),
      ).ok,
    ).toBe(false);
    expect(
      satisfiesProperty(
        5,
        { property: 'increased', by: { op: MeasureOp.AT_MOST, value: 3 } },
        before(3),
      ).ok,
    ).toBe(true);
  });

  // A string total read off the screen is the common case, and "$1,234.50" is a number to a reader.
  it('reads a number out of displayed text rather than refusing it', () => {
    expect(satisfiesProperty('$88.13', { property: 'decreased' }, before('$100.00')).ok).toBe(true);
  });

  it('refuses a reading that is not a number at all, and does not coerce it to zero', () => {
    const r = satisfiesProperty('sold out', { property: 'decreased' }, before('$100.00'));
    expect(r.ok).toBe(false);
    expect(r.because).toContain('not a number');
  });
});

/*
 * A relative property with no baseline is UNEVALUATED, never false.
 *
 * Nothing was compared, so reporting `false` would blame the app for a reading nobody took — the
 * exact mistake `inconclusive` exists to prevent one layer up.
 */
describe('no baseline', () => {
  it('says nothing was compared', () => {
    const r = satisfiesProperty(4, { property: 'increased' }, undefined);
    expect(r.ok).toBe(false);
    expect(r.unevaluated).toBe(true);
    expect(r.because).toContain('before');
  });

  it('leaves the absolute properties alone — they never needed one', () => {
    expect(satisfiesProperty('x', { property: 'nonEmpty' }, undefined).ok).toBe(true);
  });
});
