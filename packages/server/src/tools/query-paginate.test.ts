import { describe, it, expect } from 'vitest';
import { paginateQueryResult } from './query-paginate.js';

function elements(n: number): { ref: string }[] {
  return Array.from({ length: n }, (_v, i) => ({ ref: `e${String(i)}` }));
}

describe('paginateQueryResult', () => {
  it('returns the result unchanged when no limit and not count_only', () => {
    const r = { elements: elements(3), hint: undefined };
    expect(paginateQueryResult(r, undefined, false)).toBe(r);
  });

  it('count_only drops the elements array and reports the count', () => {
    const r = paginateQueryResult({ elements: elements(12) }, undefined, true) as {
      count: number;
      elements?: unknown;
    };
    expect(r.count).toBe(12);
    expect('elements' in r).toBe(false);
  });

  it('count_only preserves other fields (e.g. hint)', () => {
    const r = paginateQueryResult(
      { elements: elements(0), hint: { route: '/' } },
      undefined,
      true,
    ) as {
      count: number;
      hint: { route: string };
    };
    expect(r.count).toBe(0);
    expect(r.hint.route).toBe('/');
  });

  it('limit truncates and flags total + truncated when over the limit', () => {
    const r = paginateQueryResult({ elements: elements(10) }, 3, false) as {
      elements: unknown[];
      total: number;
      truncated: boolean;
    };
    expect(r.elements).toHaveLength(3);
    expect(r.total).toBe(10);
    expect(r.truncated).toBe(true);
  });

  it('limit is a no-op (no truncated flag) when the count is within the limit', () => {
    const r = paginateQueryResult({ elements: elements(2) }, 5, false) as {
      elements: unknown[];
      truncated?: boolean;
    };
    expect(r.elements).toHaveLength(2);
    expect(r.truncated).toBeUndefined();
  });

  it('count_only takes precedence over limit', () => {
    const r = paginateQueryResult({ elements: elements(10) }, 3, true) as {
      count: number;
      elements?: unknown;
    };
    expect(r.count).toBe(10);
    expect('elements' in r).toBe(false);
  });

  it('passes non-object / element-less results through untouched', () => {
    expect(paginateQueryResult(null, 5, false)).toBeNull();
    expect(paginateQueryResult('err', 5, true)).toBe('err');
    const hintOnly = { hint: { route: '/x' } };
    expect(paginateQueryResult(hintOnly, 5, true)).toBe(hintOnly);
  });
});
