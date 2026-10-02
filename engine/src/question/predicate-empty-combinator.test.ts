/**
 * An empty combinator is an unconditional green, and it is the cheapest false green in the grammar.
 *
 * `{ kind: "allOf", predicates: [] }` is vacuous truth: every member holds, because there are no
 * members. It parsed, it evaluated `pass: true`, and it reported `verified: "yes"` for a drive that
 * asserted nothing at all.
 *
 * Nobody writes it by hand. An agent that builds `predicates` by mapping over a list of things to
 * check emits it the moment that list is empty — a filtered-away channel, a conditional that did
 * not match — and gets a pass for a drive it never asserted.
 *
 * Two independent defences, because one of them is a boundary and the other is the floor:
 *  1. HERE — the schema refuses it, so it cannot enter the system through the documented door.
 *  2. `combine()` in the server's assert-grade returns NONE for zero branches, so a combinator that
 *     reached the evaluator some other way still grades at the floor and trips `VACUOUS_GRADE`.
 *
 * `.min(1)` is already the idiom in this file's own neighbourhood (`property.ts` uses it on
 * `oneOf.values`), so this is the established spelling rather than a new one.
 */

import { describe, expect, it } from 'vitest';
import { PredicateSchema } from './predicate/predicate.js';

describe('an empty combinator cannot parse', () => {
  it('refuses allOf with no members', () => {
    const parsed = PredicateSchema.safeParse({ kind: 'allOf', predicates: [] });
    expect(parsed.success).toBe(false);
  });

  it('refuses anyOf with no members', () => {
    const parsed = PredicateSchema.safeParse({ kind: 'anyOf', predicates: [] });
    expect(parsed.success).toBe(false);
  });

  it('still accepts a single-member combinator', () => {
    const parsed = PredicateSchema.safeParse({
      kind: 'allOf',
      predicates: [{ kind: 'signal', name: 'saved' }],
    });
    expect(parsed.success).toBe(true);
  });

  it('still accepts a nested combinator, so the refusal is about emptiness and nothing else', () => {
    const parsed = PredicateSchema.safeParse({
      kind: 'anyOf',
      predicates: [
        { kind: 'allOf', predicates: [{ kind: 'net', urlContains: '/api/save' }] },
        { kind: 'not', predicate: { kind: 'console', level: 'error' } },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  /**
   * The refusal has to be readable, because the agent that hit it is mid-drive and the next thing
   * it does is guess. Naming the field is what makes the retry informed.
   */
  it('names the field it refused', () => {
    const parsed = PredicateSchema.safeParse({ kind: 'allOf', predicates: [] });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(JSON.stringify(parsed.error.issues)).toContain('predicates');
  });
});
