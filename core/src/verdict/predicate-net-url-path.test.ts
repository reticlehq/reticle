import { describe, expect, it } from 'vitest';
import { PredicateSchema } from '../index.js';
import { failureSentence } from './check-sentence.js';
import { PredicateKind } from './consequence.js';

/**
 * `net.urlPath` names one endpoint exactly (#2286).
 *
 * The field is a path only. A value with a query or a fragment can never equal a path, so the
 * check would match nothing and fail on correct code. The schema refuses it and says what to send.
 */
describe('net urlPath in the schema', () => {
  it('accepts a path', () => {
    expect(PredicateSchema.parse({ kind: 'net', urlPath: '/api/items', count: 1 })).toEqual({
      kind: 'net',
      urlPath: '/api/items',
      count: 1,
    });
  });

  it('accepts the root path', () => {
    expect(PredicateSchema.safeParse({ kind: 'net', urlPath: '/' }).success).toBe(true);
  });

  it.each(['api/items', '/api/items?page=2', '/api/items#top', '//api/items', ''])(
    'refuses %j, which is not a path, and says what to send',
    (urlPath) => {
      const result = PredicateSchema.safeParse({ kind: 'net', urlPath });
      expect(result.success).toBe(false);
      expect(JSON.stringify(result.error?.issues)).toContain('`urlPath` is a path only');
    },
  );
});

describe('net urlPath and a predicate with no kind', () => {
  it('reads `urlPath` alone as a net check', () => {
    expect(PredicateSchema.parse({ urlPath: '/api/items', count: 1 })).toEqual({
      kind: 'net',
      urlPath: '/api/items',
      count: 1,
    });
  });

  it('keeps `pathname` alone a route check, so the field is not called `pathname`', () => {
    expect(PredicateSchema.parse({ pathname: '/done' })).toEqual({
      kind: 'route',
      pathname: '/done',
    });
  });
});

describe('net urlPath in words', () => {
  it('names the path in the failure sentence', () => {
    expect(failureSentence({ kind: PredicateKind.NET, method: 'GET', urlPath: '/api/items' })).toBe(
      'No GET request to /api/items was made',
    );
  });
});
