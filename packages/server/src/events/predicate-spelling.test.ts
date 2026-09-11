/**
 * The two spellings that cost a live drive its calls, and the refusal that has to end the guessing.
 *
 * A rejected predicate produces NO verdict — the call ends with nothing rather than with a failure —
 * so each wrong guess is a round trip spent to learn one field name. Worse, an agent that cannot
 * find the grammar falls back to a `text` predicate where a route/net/signal check was meant, which
 * is the weaker oracle this product exists to replace.
 *
 * `type` for `kind` and `of` for `not`'s child are both spellings other assertion libraries use, and
 * neither has any other meaning here. Accepting them removes two rungs of the ladder outright, which
 * is cheaper than explaining them.
 */

import { describe, expect, it } from 'vitest';
import { PredicateKind } from '@reticlehq/core';
import { parsePredicate } from './predicate-parse.js';

describe('predicate spellings an agent reaches for', () => {
  it('reads `type` as the discriminator when `kind` is absent', () => {
    expect(parsePredicate({ type: PredicateKind.TEXT, contains: 'Saved' })).toEqual({
      kind: PredicateKind.TEXT,
      contains: 'Saved',
    });
  });

  // Only when `kind` is absent. Two discriminators disagreeing is a contradiction, and dropping one
  // of them silently is how a predicate ends up asserting something nobody wrote.
  it('refuses rather than picking a winner when `kind` and `type` disagree', () => {
    expect(() =>
      parsePredicate({ kind: PredicateKind.TEXT, type: PredicateKind.NET, contains: 'Saved' }),
    ).toThrow(/type/);
  });

  it('reads `of` as `not`’s child, the way it already does for allOf/anyOf', () => {
    expect(
      parsePredicate({ kind: PredicateKind.NOT, of: { kind: PredicateKind.TEXT, contains: 'x' } }),
    ).toEqual({ kind: PredicateKind.NOT, predicate: { kind: PredicateKind.TEXT, contains: 'x' } });
  });
});

describe('a refusal that ends the ladder rather than advancing it one rung', () => {
  const messageFor = (input: unknown): string => {
    try {
      parsePredicate(input);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    throw new Error('expected the predicate to be refused');
  };

  it('names every valid kind when the discriminator itself is the mistake', () => {
    const message = messageFor({ type: 'texts', contains: 'Saved' });
    for (const kind of Object.values(PredicateKind)) expect(message).toContain(kind);
  });

  it('names the fields of the kind it was given, not just the offending key', () => {
    const message = messageFor({ kind: PredicateKind.ROUTE, equals: '/dashboard' });
    expect(message).toContain('route accepts');
    expect(message).toContain('pathname');
    expect(message).toContain('contains');
  });
});
