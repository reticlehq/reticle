/**
 * A near-miss predicate must not cost a verdict.
 *
 * Predicate rejections are the largest named class of tool error in the field, and every one of them
 * lands on `reticle_act_and_wait` / `reticle_wait_for` / `reticle_assert` — the only tools that
 * produce a verdict at all. A rejected predicate does not merely fail: nothing runs, so the drive
 * ends with no result. The agent then either retries blind or gives up and reports unverified.
 *
 * The shapes below are the ones agents actually reach for. They are not careless — they are the
 * spellings the neighbouring kinds use (`text` on a `text` predicate, a flat `role`/`text` pair from
 * `reticle_query`), which is exactly why they recur. Two defences, both here:
 *
 *  1. Accept them (aliases + lifting loose query fields), so the common miss produces a verdict.
 *  2. When a predicate still cannot parse, name the fields THAT kind accepts — so the next attempt
 *     is informed rather than another guess. That half covers the misses nobody has made yet.
 */

import { describe, expect, it } from 'vitest';
import { PredicateKind } from '@reticlehq/core';
import { parsePredicate } from './predicate-parse.js';
import { predicateFieldsFor } from './predicate-eval.js';

const messageOf = (input: unknown): string => {
  try {
    parsePredicate(input);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected parsePredicate to reject');
};

describe('predicate shapes agents actually write', () => {
  it('accepts `text` as the text predicate body, not just `contains`', () => {
    expect(parsePredicate({ kind: PredicateKind.TEXT, text: 'Saved' })).toEqual({
      kind: PredicateKind.TEXT,
      contains: 'Saved',
    });
  });

  it('accepts `value` as the text predicate body', () => {
    expect(parsePredicate({ kind: PredicateKind.TEXT, value: 'Saved' })).toEqual({
      kind: PredicateKind.TEXT,
      contains: 'Saved',
    });
  });

  it('lifts a flat role/text pair into the element query', () => {
    expect(parsePredicate({ kind: PredicateKind.ELEMENT, role: 'button', text: 'Save' })).toEqual({
      kind: PredicateKind.ELEMENT,
      query: { role: 'button', text: 'Save' },
    });
  });

  it('lifts a flat testid into the element query', () => {
    expect(parsePredicate({ kind: PredicateKind.ELEMENT, testid: 'row-3' })).toEqual({
      kind: PredicateKind.ELEMENT,
      query: { testid: 'row-3' },
    });
  });

  it('keeps an explicit query when both shapes are supplied', () => {
    expect(
      parsePredicate({ kind: PredicateKind.ELEMENT, query: { testid: 'real' }, role: 'button' }),
    ).toEqual({ kind: PredicateKind.ELEMENT, query: { testid: 'real' } });
  });

  it('still rejects a field that is nobody’s spelling', () => {
    expect(messageOf({ kind: PredicateKind.TEXT, contains: 'x', nonsense: 1 })).toMatch(
      /unknown field nonsense/,
    );
  });
});

describe('a rejection names the fields that kind accepts', () => {
  it('lists the element predicate fields', () => {
    const message = messageOf({ kind: PredicateKind.ELEMENT, selector: '.grid' });
    expect(message).toContain('element accepts');
    expect(message).toContain('query');
    expect(message).toContain('absent');
  });

  it('lists the net predicate fields', () => {
    const message = messageOf({ kind: PredicateKind.NET, nope: 1 });
    expect(message).toContain('urlContains');
    expect(message).toContain('status');
  });

  it('names the valid kinds when the kind itself is wrong', () => {
    const message = messageOf({ kind: 'appears', text: 'x' });
    expect(message).toContain(PredicateKind.ELEMENT);
    expect(message).toContain(PredicateKind.SIGNAL);
  });
});

describe('predicateFieldsFor stays derived from the schema', () => {
  it('reports every kind in the union', () => {
    for (const kind of Object.values(PredicateKind)) {
      expect(predicateFieldsFor(kind).length, kind).toBeGreaterThan(0);
    }
  });

  it('reports nothing for a kind that does not exist', () => {
    expect(predicateFieldsFor('nope')).toEqual([]);
  });
});

describe('scoping the text predicate', () => {
  it('accepts `scope` alongside `contains`', () => {
    // Without this the strict schema rejects the whole predicate, and a rejected predicate costs
    // the verdict entirely — see the header of this file.
    expect(
      parsePredicate({ kind: PredicateKind.TEXT, contains: 'Floor', scope: '[role=dialog]' }),
    ).toEqual({
      kind: PredicateKind.TEXT,
      contains: 'Floor',
      scope: '[role=dialog]',
    });
  });

  it('accepts `scope` with the `text` alias too', () => {
    expect(parsePredicate({ kind: PredicateKind.TEXT, text: 'Floor', scope: '#modal' })).toEqual({
      kind: PredicateKind.TEXT,
      contains: 'Floor',
      scope: '#modal',
    });
  });

  it('keeps the predicate page-wide when no scope is given', () => {
    // Adding the field must not change what an existing caller means.
    expect(parsePredicate({ kind: PredicateKind.TEXT, contains: 'Floor' })).toEqual({
      kind: PredicateKind.TEXT,
      contains: 'Floor',
    });
  });

  it('names `scope` among the fields the text predicate accepts', () => {
    expect(predicateFieldsFor(PredicateKind.TEXT)).toContain('scope');
  });
});
