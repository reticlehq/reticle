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

  /**
   * The browser counts matches BEFORE the result is serialized; the wire sanitizer then caps the
   * elements array (200 items, and a node budget that bites sooner). So on a large page the array
   * that arrives here is shorter than the number of elements that actually matched, and deriving the
   * count from `elements.length` reports the truncation as if it were the answer.
   *
   * This is the worst shape of wrong a verification tool can produce: an authoritative-looking number
   * that is quietly capped. "How many broken buttons are there?" answered 200 when it is 5000 is not a
   * degraded answer, it is a false one.
   */
  describe('when the wire truncated the elements array', () => {
    it('count_only reports the browser count, not the surviving array length', () => {
      const r = paginateQueryResult({ count: 5000, elements: elements(200) }, undefined, true) as {
        count: number;
      };
      expect(r.count).toBe(5000);
    });

    it('count_only marks the result truncated so the number is never read as complete', () => {
      const r = paginateQueryResult({ count: 5000, elements: elements(200) }, undefined, true) as {
        truncated?: boolean;
      };
      expect(r.truncated).toBe(true);
    });

    it('limit reports the browser count as total', () => {
      const r = paginateQueryResult({ count: 5000, elements: elements(200) }, 10, false) as {
        total: number;
        truncated: boolean;
      };
      expect(r.total).toBe(5000);
      expect(r.truncated).toBe(true);
    });

    it('flags truncation even when no limit was asked for', () => {
      const r = paginateQueryResult({ count: 5000, elements: elements(200) }, undefined, false) as {
        total?: number;
        truncated?: boolean;
      };
      expect(r.truncated).toBe(true);
      expect(r.total).toBe(5000);
    });

    it('does not flag truncation when the array arrived intact', () => {
      const r = paginateQueryResult({ count: 3, elements: elements(3) }, undefined, false) as {
        truncated?: boolean;
      };
      expect(r.truncated).toBeUndefined();
    });
  });

  it('passes non-object / element-less results through untouched', () => {
    expect(paginateQueryResult(null, 5, false)).toBeNull();
    expect(paginateQueryResult('err', 5, true)).toBe('err');
    const hintOnly = { hint: { route: '/x' } };
    expect(paginateQueryResult(hintOnly, 5, true)).toBe(hintOnly);
  });
});
