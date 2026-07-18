import { describe, it, expect } from 'vitest';
import { selectPath, capDepth } from './state-select.js';

describe('selectPath', () => {
  it('walks object keys and numeric array indices', () => {
    const root = { items: [{ id: 1 }, { id: 2 }] };
    expect(selectPath(root, 'items.1.id')).toEqual({ found: true, value: 2 });
  });

  it('reports found:false + availableKeys on a missing key', () => {
    const r = selectPath({ a: 1, b: 2 }, 'c');
    expect(r.found).toBe(false);
    expect(r.availableKeys).toEqual(['a', 'b']);
  });

  it('reports found:false for an out-of-range array index', () => {
    expect(selectPath({ xs: [10] }, 'xs.5').found).toBe(false);
  });

  it('cannot reach a key that literally contains a dot (documented ambiguity)', () => {
    // 'v3.0' splits into ['v3','0'] — a float-looking key is unreachable via dot-path.
    expect(selectPath({ 'v3.0': { text: 'x' } }, 'v3.0.text').found).toBe(false);
  });

  it('returns the whole root for an empty path', () => {
    expect(selectPath({ a: 1 }, '')).toEqual({ found: true, value: { a: 1 } });
  });
});

describe('capDepth', () => {
  it('a negative budget means no cap (value returned unchanged)', () => {
    const deep = { a: { b: { c: 1 } } };
    expect(capDepth(deep, -1)).toEqual(deep);
  });

  it('maxDepth 0 collapses objects and arrays to size markers', () => {
    expect(capDepth({ a: 1, b: 2 }, 0)).toBe('{…2 keys}');
    expect(capDepth([1, 2, 3], 0)).toBe('[Array(3)]');
  });

  it('prunes only past the budget', () => {
    expect(capDepth({ a: { b: 1 } }, 1)).toEqual({ a: '{…1 keys}' });
    expect(capDepth({ a: { b: 1 } }, 2)).toEqual({ a: { b: 1 } });
  });
});
