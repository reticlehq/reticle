import { describe, it, expect } from 'vitest';
import { selectPath, capDepth, projectComponentState } from './state-select.js';

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

  it('rejects non-canonical numeric segments — 01 / 1e0 / " 1" are not array index 1', () => {
    const root = { xs: [10, 20, 30] };
    expect(selectPath(root, 'xs.1')).toEqual({ found: true, value: 20 }); // canonical still works
    for (const seg of ['01', '1e0', ' 1', '+1', '1.0']) {
      expect(selectPath(root, `xs.${seg}`).found, `xs.${seg} must not resolve to index 1`).toBe(
        false,
      );
    }
  });

  it('bounds availableKeys on a miss — a huge store does not return every key in the error', () => {
    const wide: Record<string, number> = {};
    for (let i = 0; i < 500; i++) wide[`k${String(i)}`] = i;
    const r = selectPath(wide, 'nope');
    expect(r.found).toBe(false);
    expect(r.availableKeys?.length).toBeLessThanOrEqual(50);
  });

  it('cannot reach a key that literally contains a dot (documented ambiguity)', () => {
    // 'v3.0' splits into ['v3','0'] — a float-looking key is unreachable via dot-path.
    expect(selectPath({ 'v3.0': { text: 'x' } }, 'v3.0.text').found).toBe(false);
  });

  it('returns the whole root for an empty path', () => {
    expect(selectPath({ a: 1 }, '')).toEqual({ found: true, value: { a: 1 } });
  });

  it('resolves .length on an array — the form the wait_for/assert example itself ships', () => {
    expect(selectPath({ items: ['First task'] }, 'items.length')).toEqual({
      found: true,
      value: 1,
    });
    expect(selectPath({ todos: [1, 2, 3] }, 'todos.length')).toEqual({ found: true, value: 3 });
    // and it keeps walking afterwards is impossible (number is a leaf), but a nested array works:
    expect(selectPath({ a: { b: [[], []] } }, 'a.b.0.length')).toEqual({ found: true, value: 0 });
  });

  it('resolves .length on a string', () => {
    expect(selectPath({ name: 'abcd' }, 'name.length')).toEqual({ found: true, value: 4 });
  });

  it('offers length in availableKeys when an array/string path misses', () => {
    expect(selectPath({ items: ['x'] }, 'items.lenght').availableKeys).toContain('length');
    expect(selectPath({ name: 'abcd' }, 'name.size').availableKeys).toEqual(['length']);
  });

  it('allows no intrinsic beyond length — size/constructor/__proto__ on an array stay unreachable', () => {
    for (const seg of ['size', 'constructor', '__proto__', 'toString', 'map', 'push']) {
      expect(selectPath({ xs: [1] }, `xs.${seg}`).found, `xs.${seg} must not be found`).toBe(false);
      expect(selectPath({ s: 'ab' }, `s.${seg}`).found, `s.${seg} must not be found`).toBe(false);
    }
  });

  it('does NOT resolve .length on a plain object that has no own length key', () => {
    expect(selectPath({ a: 1 }, 'length').found).toBe(false);
    expect(selectPath({ o: { length: 7 } }, 'o.length')).toEqual({ found: true, value: 7 });
  });

  it('does NOT resolve prototype-chain keys — constructor/__proto__/toString are not state paths', () => {
    // `in` walked the prototype, so a typo'd path shadowing a builtin returned found:true against a
    // function from Object.prototype, and a state assertion on it silently passed. Only OWN keys count.
    for (const proto of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(selectPath({ a: 1 }, proto).found, `${proto} must not be found`).toBe(false);
    }
    // A real own key that happens to be named like a builtin is still reachable.
    expect(selectPath({ toString: 42 }, 'toString')).toEqual({ found: true, value: 42 });
  });
});

describe('selectPath — Map support', () => {
  it('walks into a Map by string key', () => {
    const state = { byId: new Map([['a', { name: 'alice' }]]) };
    expect(selectPath(state, 'byId.a.name')).toEqual({ found: true, value: 'alice' });
  });

  it('reports available Map keys on a miss', () => {
    const state = {
      byId: new Map([
        ['x', 1],
        ['y', 2],
      ]),
    };
    const r = selectPath(state, 'byId.z');
    expect(r.found).toBe(false);
    expect(r.availableKeys).toContain('x');
    expect(r.availableKeys).toContain('y');
  });

  it('returns the Map itself when the path stops at it', () => {
    const m = new Map([['k', 'v']]);
    expect(selectPath({ m }, 'm')).toEqual({ found: true, value: m });
  });

  it('only reports string keys in availableKeys for a Map (non-string keys omitted)', () => {
    const m = new Map<unknown, number>([
      ['str', 1],
      [42, 2],
      [Symbol('s'), 3],
    ]);
    const r = selectPath({ m }, 'm.missing');
    expect(r.found).toBe(false);
    expect(r.availableKeys).toEqual(['str']);
  });
});

describe('capDepth — Date/Map/Set handling', () => {
  it('treats Date as a leaf and returns its ISO string at any depth', () => {
    const d = new Date('2026-01-01T00:00:00Z');
    expect(capDepth(d, 0)).toBe('2026-01-01T00:00:00.000Z');
    expect(capDepth({ t: d }, 1)).toEqual({ t: '2026-01-01T00:00:00.000Z' });
  });

  it('degrades an invalid Date to null instead of throwing', () => {
    expect(capDepth(new Date(NaN), 0)).toBeNull();
    expect(capDepth({ t: new Date('invalid') }, 1)).toEqual({ t: null });
  });

  it('converts a Set to an array with depth capping', () => {
    const s = new Set(['a', 'b']);
    expect(capDepth(s, 1)).toEqual(['a', 'b']);
    expect(capDepth(s, 0)).toBe('[Set(2)]');
  });

  it('converts a Map to an object with depth capping', () => {
    const m = new Map<string, unknown>([['x', { nested: 1 }]]);
    expect(capDepth(m, 2)).toEqual({ x: { nested: 1 } });
    expect(capDepth(m, 1)).toEqual({ x: '{…1 keys}' });
    expect(capDepth(m, 0)).toBe('{Map(1)}');
  });

  it('recurses through nested Date/Map/Set correctly', () => {
    const state = {
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      selected: new Set(['a', 'b']),
      byId: new Map([['a', 1]]),
      n: 5,
    };
    const capped = capDepth(state, 3);
    expect(capped).toEqual({
      updatedAt: '2026-01-01T00:00:00.000Z',
      selected: ['a', 'b'],
      byId: { a: 1 },
      n: 5,
    });
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

/**
 * Fixture mirroring a REAL React 19 fiber read (captured by rendering a cart component with five
 * useState, one useRef, one useMemo, one useCallback and three useEffect through @reticlehq/react's
 * readState under jsdom). Measured on that real payload: 2632 bytes of JSON in,
 * 1333 bytes out (disclosure note included) — the three effect entries, each a
 * `{tag, create:null, deps, inst:{destroy:null}, next:{…}}` chain, are half the read.
 */
const CART_ROWS = Array.from({ length: 6 }, (_, i) => ({
  id: `line-${String(i)}`,
  sku: `SKU-000${String(i)}`,
  qty: i + 1,
  price: 199 + i,
}));

function effectHook(deps: unknown[], next: unknown): unknown {
  return { tag: 9, create: null, deps, inst: { destroy: null }, next };
}

const FILTERS = { status: 'open', sort: 'price', page: 1 };
const NULLED_ROWS = CART_ROWS.map(() => null);

const RAW_CART_STATE = {
  ok: true,
  component: 'Cart',
  hooks: [
    CART_ROWS, // useState(items)
    '', // useState(coupon)
    false, // useState(busy)
    null, // useState(error)
    FILTERS, // useState(filters)
    { current: '[Node]' }, // useRef
    [4249, [CART_ROWS]], // useMemo -> [value, deps]
    [null, ['', CART_ROWS]], // useCallback -> [fn (nulled), deps]
    effectHook(
      ['', CART_ROWS, false],
      effectHook([4249, FILTERS], effectHook([CART_ROWS, FILTERS, ''], null)),
    ),
    effectHook(
      [4249, FILTERS],
      effectHook([NULLED_ROWS, FILTERS, ''], effectHook(['', null, false], null)),
    ),
    effectHook([CART_ROWS, FILTERS, ''], effectHook(['', NULLED_ROWS, false], null)),
  ],
};

describe('projectComponentState', () => {
  it('drops React effect hooks and keeps every value hook, well under half the raw size', () => {
    const rawBytes = JSON.stringify(RAW_CART_STATE).length;
    const projected = projectComponentState(RAW_CART_STATE);
    const projectedBytes = JSON.stringify(projected).length;

    expect(rawBytes).toBeGreaterThan(2000); // the measured real payload is 2632 bytes
    expect(projectedBytes).toBeLessThan(rawBytes * 0.6);
    expect(projected).toMatchObject({
      ok: true,
      component: 'Cart',
      hooks: [
        CART_ROWS,
        '',
        false,
        null,
        FILTERS,
        { current: '[Node]' },
        [4249, [CART_ROWS]],
        [null, ['', CART_ROWS]],
      ],
    });
  });

  it('adds no disclosure when there was nothing to drop', () => {
    const clean = { ok: true, component: 'Toggle', hooks: [false, { current: null }] };
    expect(projectComponentState(clean)).toEqual(clean);
  });

  it('leaves a non-conforming value untouched', () => {
    expect(projectComponentState(undefined)).toBeUndefined();
    expect(projectComponentState({ ok: false, reason: 'component-state-unavailable' })).toEqual({
      ok: false,
      reason: 'component-state-unavailable',
    });
  });

  it('keeps a two-element state value that merely looks like a memo tuple', () => {
    const pair = { ok: true, hooks: [['lat', ['a', 'b']]] };
    expect(projectComponentState(pair)).toEqual(pair);
  });
});
