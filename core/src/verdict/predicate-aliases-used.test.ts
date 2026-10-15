import { describe, expect, it } from 'vitest';
import { PredicateSchema, predicateAliasesUsed } from '../index.js';

describe('forgiving parse, said out loud', () => {
  it('names each alias it normalised, and the normalised predicate parses', () => {
    const written = { kind: 'route', pathContains: '/settings' };
    expect(predicateAliasesUsed(written)).toEqual(['route.pathContains → contains']);
    expect(PredicateSchema.parse(written)).toEqual({ kind: 'route', contains: '/settings' });
    expect(predicateAliasesUsed({ kind: 'net', pathContains: '/api/keys' })).toEqual([
      'net.pathContains → urlContains',
    ]);
  });

  it('reports type → kind, flat element fields and nested members', () => {
    expect(
      predicateAliasesUsed({
        type: 'allOf',
        of: [
          { kind: 'text', text: 'Saved' },
          { kind: 'element', role: 'button', name: 'Go' },
        ],
      }),
    ).toEqual([
      'type → kind',
      'allOf.of → predicates',
      'text.text → contains',
      'element.role → query.role',
      'element.name → query.name',
    ]);
  });

  it('a canonical spelling reports nothing', () => {
    expect(predicateAliasesUsed({ kind: 'route', contains: '/x' })).toEqual([]);
  });

  it('never guesses an unknown field: it is not reported, and the schema still refuses it', () => {
    const written = { kind: 'route', pathStartsWith: '/x' };
    expect(predicateAliasesUsed(written)).toEqual([]);
    expect(PredicateSchema.safeParse(written).success).toBe(false);
  });
});

/*
 * A flat field beside an explicit `query` was dropped without a word: `{ kind: "element",
 * query: { testid: "total" }, value: "42" }` checked only that the element exists, and passed
 * whatever it held. A field the parse does not use is refused, as `ref` is.
 */
describe('a flat query field beside an explicit query', () => {
  it('is refused, never dropped', () => {
    const written = { kind: 'element', query: { testid: 'total' }, value: '42' };
    expect(PredicateSchema.safeParse(written).success).toBe(false);
    expect(
      PredicateSchema.safeParse({ kind: 'element', value: '42', testid: 'total' }).success,
    ).toBe(true);
  });
});
