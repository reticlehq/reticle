import { describe, expect, it } from 'vitest';
import { textPredicateQuery } from './predicate-element.js';

/**
 * `contains: "Saved Priya@studio.dev"` passed against a page reading "Saved priya@studio.dev": the
 * check went out as an ordinary text search, which ignores case. A check compares case exactly
 * unless it says otherwise.
 */
describe('the element query a text predicate sends', () => {
  it('asks for case-exact text by default', () => {
    expect(textPredicateQuery({ contains: 'Saved Priya' })).toEqual({
      text: 'Saved Priya',
      matchCase: true,
    });
  });

  it('ignores case only when the predicate asks to', () => {
    expect(textPredicateQuery({ contains: 'saved', ignoreCase: true })).toEqual({ text: 'saved' });
  });

  it('carries scope and self', () => {
    expect(textPredicateQuery({ contains: 'x', scope: '#s', self: true })).toEqual({
      text: 'x',
      matchCase: true,
      scope: '#s',
      self: true,
    });
  });

  /*
   * Persona drive: the engine sent `matchCase` on every text check, and a page on an older SDK
   * rejects a query field it does not know, so every text check there was a false "no".
   */
  it('leaves matchCase out for a page SDK older than the release that added it, and keeps it from that release', () => {
    expect(textPredicateQuery({ contains: 'Signed in' }, '3.4.0')).toEqual({ text: 'Signed in' });
    expect(textPredicateQuery({ contains: 'Signed in' }, '3.7.0')).toEqual({
      text: 'Signed in',
      matchCase: true,
    });
  });
});
