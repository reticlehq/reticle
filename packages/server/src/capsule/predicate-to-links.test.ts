import { describe, expect, it } from 'vitest';
import type { Predicate } from '../events/predicate.js';
import { predicateToExpectedLinks } from './predicate-to-links.js';

describe('predicateToExpectedLinks', () => {
  it('maps signal/net/state predicates to expected links', () => {
    expect(predicateToExpectedLinks({ kind: 'signal', name: 'order:placed' })).toEqual([
      { kind: 'signal', name: 'order:placed' },
    ]);
    expect(
      predicateToExpectedLinks({ kind: 'net', urlContains: '/api/order', status: 200 }),
    ).toEqual([{ kind: 'net', urlContains: '/api/order', status: 200 }]);
    expect(predicateToExpectedLinks({ kind: 'state', store: 'cart', path: 'count' })).toEqual([
      { kind: 'state', name: 'cart' },
    ]);
  });

  it('flattens allOf in order', () => {
    const predicate = {
      kind: 'allOf',
      predicates: [
        { kind: 'net', urlContains: '/api/order' },
        { kind: 'signal', name: 'order:placed' },
      ],
    } as Predicate;
    expect(predicateToExpectedLinks(predicate)).toEqual([
      { kind: 'net', urlContains: '/api/order' },
      { kind: 'signal', name: 'order:placed' },
    ]);
  });

  it('skips presence and settled predicates (no dataflow link)', () => {
    expect(predicateToExpectedLinks({ kind: 'settled' })).toEqual([]);
    expect(predicateToExpectedLinks({ kind: 'element', query: { testid: 'x' } })).toEqual([]);
  });
});
