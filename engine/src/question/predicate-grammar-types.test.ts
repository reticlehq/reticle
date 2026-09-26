/**
 * #1001.2: the predicate grammar must name value domains, not just field names.
 *
 * Agents learned `by` has no `css` and `attrs` is an array only after several failed parses.
 * The grammar is derived from the schema so it cannot drift.
 */

import { describe, expect, it } from 'vitest';
import { ElementQuerySchema, PredicateKind, QueryBy } from '@reticlehq/core';
import { parsePredicate } from './predicate/predicate-parse.js';
import {
  fieldHintOf,
  predicateGrammar,
  predicateNestedFieldHintsFor,
} from './predicate/predicate-eval.js';

const messageOf = (input: unknown): string => {
  try {
    parsePredicate(input);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected parsePredicate to reject');
};

describe('predicateGrammar names value domains for element.query', () => {
  const element = predicateGrammar()[PredicateKind.ELEMENT];
  const queryHints = predicateNestedFieldHintsFor(PredicateKind.ELEMENT).query;

  it('lists every QueryBy value on by, and css is not one of them', () => {
    const byHint = queryHints?.by ?? '';
    for (const value of Object.values(QueryBy)) {
      expect(byHint).toContain(value);
    }
    expect(byHint).not.toContain('css');
    expect(element).toContain(`by: ${byHint}`);
  });

  it('says attrs is a string array', () => {
    expect(queryHints?.attrs).toBe('string[]');
    expect(element).toContain('attrs: string[]');
  });

  it('names scalar locator fields as strings', () => {
    expect(queryHints?.role).toBe('string');
    expect(queryHints?.testid).toBe('string');
  });
});

describe('a rejection carries the same value domains', () => {
  it('expands query with types when query is what failed', () => {
    const message = messageOf({ kind: PredicateKind.ELEMENT, query: 'a string' });
    expect(message).toContain('query accepts:');
    expect(message).toContain('attrs: string[]');
    expect(message).toContain(`by: ${Object.values(QueryBy).join('|')}`);
  });
});

describe('fieldHintOf reads zod shapes', () => {
  it('describes ElementQuerySchema fields from the contract', () => {
    expect(fieldHintOf(ElementQuerySchema.shape.attrs)).toBe('string[]');
    expect(fieldHintOf(ElementQuerySchema.shape.by)).toContain(QueryBy.ROLE);
  });
});
