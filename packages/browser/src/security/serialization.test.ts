import { describe, expect, it } from 'vitest';
import { REDACTED_VALUE, TRANSPORT_LIMITS } from '@reticlehq/core';
import {
  isSensitiveKey,
  safeStringify,
  sanitizeForTransport,
  sanitizeWithReport,
  scrubKnownSecrets,
} from './serialization.js';

describe('isSensitiveKey — session/jwt/pwd/sid coverage without substring false positives', () => {
  it('matches common session identifiers and short credential keys', () => {
    for (const k of [
      'sessionid',
      'session_id',
      'session-id',
      'jwt',
      'pwd',
      'sid',
      'JWT',
      'accessToken',
    ]) {
      expect(isSensitiveKey(k)).toBe(true);
    }
  });
  it('does NOT redact benign keys that merely CONTAIN those letters', () => {
    for (const k of ['president', 'consider', 'outside', 'rapid', 'valid', 'jwtxCount', 'upward']) {
      expect(isSensitiveKey(k)).toBe(false);
    }
  });
});

describe('scrubKnownSecrets — high-confidence shapes, no prose corruption', () => {
  it('redacts JWTs and provider key prefixes regardless of surrounding key', () => {
    expect(scrubKnownSecrets('token is eyJhbGciOi.eyJzdWIiOi.abc123XYZ done')).toContain(
      REDACTED_VALUE,
    );
    expect(scrubKnownSecrets('key sk_live_abcd1234efgh5678')).toBe(`key ${REDACTED_VALUE}`);
    expect(scrubKnownSecrets('aws AKIAIOSFODNN7EXAMPLE here')).toContain(REDACTED_VALUE);
  });
  it('leaves ordinary prose untouched', () => {
    const prose = 'The quick brown fox jumps over the lazy dog, again and again.';
    expect(scrubKnownSecrets(prose)).toBe(prose);
  });
});

describe('transport serialization', () => {
  it('redacts sensitive keys at every depth', () => {
    expect(
      sanitizeForTransport({
        password: 'open-sesame',
        nested: { apiKey: 'key-123', value: 1 },
      }),
    ).toEqual({
      password: REDACTED_VALUE,
      nested: { apiKey: REDACTED_VALUE, value: 1 },
    });
  });

  it('redacts auth tokens but NOT compound design-token fields', () => {
    expect(
      sanitizeForTransport({
        accessToken: 'secret-abc',
        authToken: 'secret-def',
        token: 'secret-ghi',
        // design fields — must survive (the old /token/ regex falsely redacted these)
        colorToken: '--accent',
        backgroundToken: '--surface',
        tokenCount: 17,
        offTheme: true,
      }),
    ).toEqual({
      accessToken: REDACTED_VALUE,
      authToken: REDACTED_VALUE,
      token: REDACTED_VALUE,
      colorToken: '--accent',
      backgroundToken: '--surface',
      tokenCount: 17,
      offTheme: true,
    });
  });

  it('handles BigInt and cycles without throwing', () => {
    // BigInt(2), not 2n: the browser package compiles to ES2017 for webpack 4 (issue #680),
    // and BigInt literals need ES2020. Same runtime value; tests do not ship.
    const value: Record<string, unknown> = { count: BigInt(2) };
    value['self'] = value;
    expect(() => safeStringify(value)).not.toThrow();
    expect(JSON.parse(safeStringify(value))).toEqual({
      count: '2',
      self: '[CIRCULAR]',
    });
  });

  it('omits undefined object properties and preserves array positions', () => {
    expect(
      JSON.parse(
        safeStringify({
          omitted: undefined,
          items: [undefined, () => undefined, Symbol('value')],
        }),
      ),
    ).toEqual({ items: [null, null, null] });
  });

  it('contains hostile proxy failures', () => {
    const proxy = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error('blocked');
        },
      },
    );
    expect(safeStringify(proxy)).toBe('"[UNSERIALIZABLE]"');
  });

  it('bounds long strings and collections', () => {
    const result = sanitizeForTransport({
      text: 'x'.repeat(TRANSPORT_LIMITS.MAX_STRING_LENGTH + 100),
      items: Array.from({ length: TRANSPORT_LIMITS.MAX_COLLECTION_ITEMS + 10 }, (_, i) => i),
    }) as { text: string; items: unknown[] };
    expect(result.text.length).toBeLessThanOrEqual(TRANSPORT_LIMITS.MAX_STRING_LENGTH);
    expect(result.text.endsWith('[TRUNCATED]')).toBe(true);
    expect(result.items).toHaveLength(TRANSPORT_LIMITS.MAX_COLLECTION_ITEMS);
  });
});

/**
 * The server reports match counts from the `count` field rather than `elements.length`, because the
 * array is capped in transit while the count is not. That fix is only sound if `count` actually
 * survives a payload big enough to exhaust the node budget — and it survives for a non-obvious
 * reason: `matchQuery` emits `count` BEFORE `elements`, and the sanitizer spends its budget in key
 * order. Reordering those two keys would silently turn the count into "[TRUNCATED]" and put the
 * wrong-number bug straight back. This test is the thing that would go red if that happened.
 */
describe('scalar counts survive a payload that exhausts the node budget', () => {
  function queryShapedResult(matches: number): unknown {
    return {
      matched: matches > 0,
      count: matches,
      elements: Array.from({ length: matches }, (_v, i) => ({
        ref: `e${String(i)}`,
        role: 'button',
        name: `row ${String(i)} action`,
        testid: `row-${String(i)}`,
        visible: true,
      })),
    };
  }

  it('keeps count exact when the elements array is truncated', () => {
    const wire = sanitizeForTransport(queryShapedResult(5000)) as {
      count: unknown;
      elements: unknown[];
    };
    expect(wire.count).toBe(5000);
    expect(wire.elements.length).toBeLessThan(5000);
  });

  it('keeps count exact even when it is declared AFTER the huge array', () => {
    // The order-independent version of the test above. Before the sanitizer sorted scalars ahead of
    // collections, this shape lost its count to the node budget — so a producer that happened to
    // write `elements` first silently reintroduced the wrong-number bug.
    const wire = sanitizeForTransport({
      elements: Array.from({ length: 5000 }, (_v, i) => ({
        ref: `e${String(i)}`,
        role: 'button',
        name: `row ${String(i)} action`,
        testid: `row-${String(i)}`,
        visible: true,
      })),
      count: 5000,
    }) as { count: unknown };
    expect(wire.count).toBe(5000);
  });

  it('the truncation this guards against is real, not hypothetical', () => {
    const wire = sanitizeForTransport(queryShapedResult(5000)) as { elements: unknown[] };
    // If this ever stops truncating, the count fix is untested rather than passing.
    expect(wire.elements.length).toBeLessThanOrEqual(200);
  });
});

/**
 * A partially-serialized array ITEM is worse than a missing one.
 *
 * The node budget used to run out in the middle of a collection, so later items kept their shape but
 * had individual fields replaced by the string "[TRUNCATED]" — an array field became a string, a
 * boolean became a string. The server declares an output schema for these payloads, so the result was
 * not a degraded answer: the entire tool call failed output validation and the agent received NOTHING.
 * On a page with thousands of matching elements that is a total loss of the query tool.
 *
 * Items are now whole or absent. The count travels separately, so "how many" stays exact while the
 * sample shrinks.
 */
describe('collections truncate by dropping whole items, never by corrupting them', () => {
  function descriptors(n: number): unknown[] {
    return Array.from({ length: n }, (_v, i) => ({
      ref: `e${String(i)}`,
      role: 'button',
      name: `cell ${String(i)}`,
      states: ['present', 'visible', 'enabled'],
      visible: true,
      source: 'src/views/Enterprise.tsx:67',
    }));
  }

  it('every surviving item keeps its declared field types', () => {
    const wire = sanitizeForTransport({ count: 4016, elements: descriptors(4016) }) as {
      elements: Record<string, unknown>[];
    };
    expect(wire.elements.length).toBeGreaterThan(0);
    for (const el of wire.elements) {
      expect(Array.isArray(el['states'])).toBe(true);
      expect(typeof el['visible']).toBe('boolean');
      expect(typeof el['ref']).toBe('string');
    }
  });

  it('drops items rather than emitting placeholder strings in their place', () => {
    const wire = sanitizeForTransport({ count: 4016, elements: descriptors(4016) }) as {
      elements: unknown[];
    };
    for (const el of wire.elements) expect(typeof el).toBe('object');
  });

  it('still reports the exact count alongside the shortened sample', () => {
    const wire = sanitizeForTransport({ count: 4016, elements: descriptors(4016) }) as {
      count: unknown;
      elements: unknown[];
    };
    expect(wire.count).toBe(4016);
    expect(wire.elements.length).toBeLessThan(4016);
  });
});

/**
 * An item that STARTS under the budget can cross it partway through. Checking only before the item
 * leaves the last one able to ship with its tail replaced by placeholders — the same schema-invalid
 * payload, just rarer and dependent on how the item size happens to divide the budget.
 */
describe('the last surviving item is whole, whatever the item size', () => {
  for (const fieldCount of [3, 5, 7, 11, 13]) {
    it(`keeps types intact with ${String(fieldCount)}-field items`, () => {
      const item = (i: number): Record<string, unknown> => {
        const o: Record<string, unknown> = { id: `e${String(i)}`, flag: true, tags: ['a', 'b'] };
        for (let f = 0; f < fieldCount; f += 1) o[`f${String(f)}`] = `value-${String(f)}`;
        return o;
      };
      const wire = sanitizeForTransport({
        count: 5000,
        rows: Array.from({ length: 5000 }, (_v, i) => item(i)),
      }) as { rows: Record<string, unknown>[] };
      expect(wire.rows.length).toBeGreaterThan(0);
      for (const row of wire.rows) {
        expect(typeof row['flag']).toBe('boolean');
        expect(Array.isArray(row['tags'])).toBe(true);
        for (let f = 0; f < fieldCount; f += 1) {
          expect(typeof row[`f${String(f)}`]).toBe('string');
          expect(row[`f${String(f)}`]).not.toBe('[TRUNCATED]');
        }
      }
    });
  }
});

describe('truncation is disclosed, never silent', () => {
  it('reports how many items a big collection lost', () => {
    // The defect this closes: a 1,000-entity store came back as ~142 entities with no marker. A
    // caller comparing that against expected data reads "the app lost the rest" (false failure); a
    // caller asserting absence reads it as proof (false green). Neither is recoverable from the
    // payload, so the fact of truncation has to travel beside it.
    const big = { rows: Array.from({ length: 1000 }, (_, i) => ({ id: i, name: `row-${i}` })) };
    const { value, truncation } = sanitizeWithReport(big);
    const rows = (value as { rows: unknown[] }).rows;
    expect(rows.length).toBeLessThan(1000);
    expect(truncation?.droppedItems).toBeGreaterThan(0);
    expect(truncation?.note).toContain('NOT the whole value');
  });

  it('says NOTHING when the value fitted — silence must keep meaning complete', () => {
    const { value, truncation } = sanitizeWithReport({ a: 1, b: ['x', 'y'] });
    expect(value).toEqual({ a: 1, b: ['x', 'y'] });
    expect(truncation).toBeUndefined();
  });

  it('counts placeholder replacements from a too-deep value', () => {
    // Depth cap replaces the value with "[TRUNCATED]" — a string where an object was. That type
    // change is exactly what breaks a consumer's schema, so it must be counted.
    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 15; i++) deep = { nest: deep };
    const { truncation } = sanitizeWithReport(deep);
    expect(truncation?.truncatedValues).toBeGreaterThan(0);
  });

  it('sanitizeForTransport keeps its old shape exactly (no behaviour change for existing callers)', () => {
    const input = { a: 1, list: [1, 2, 3] };
    expect(sanitizeForTransport(input)).toEqual(sanitizeWithReport(input).value);
  });

  it('reports a truncated STRING instead of silently shortening it', () => {
    // A 500k-char value cut to the cap used to carry no marker, so a caller comparing it to expected
    // data read "the app dropped the rest" — the same false green the collection caps already report.
    const { value, truncation } = sanitizeWithReport({ blob: 'x'.repeat(500_000) });
    expect((value as { blob: string }).blob.length).toBeLessThan(500_000);
    expect(truncation?.truncatedValues).toBeGreaterThan(0);
  });

  it('reports object KEYS dropped past the cap instead of reading as a complete object', () => {
    const wide: Record<string, number> = {};
    for (let i = 0; i < 5_000; i++) wide[`k${String(i)}`] = i;
    const { value, truncation } = sanitizeWithReport(wide);
    expect(Object.keys(value as object).length).toBeLessThan(5_000);
    expect(truncation?.droppedItems).toBeGreaterThan(0);
  });
});

describe('an invalid Date does not crash the whole state read', () => {
  it('degrades new Date(NaN) to null instead of throwing RangeError', () => {
    // sanitizeForTransport is called DIRECTLY (readStoresWithTruncation, the state observer) — not
    // only via safeStringify — so an unguarded toISOString() on one bad Date threw and took out the
    // entire STATE_READ. One invalid Date in app state must not blind the agent to the rest of it.
    expect(() => sanitizeForTransport({ when: new Date(NaN), ok: 1 })).not.toThrow();
    expect(sanitizeForTransport({ when: new Date(NaN), ok: 1 })).toEqual({ when: null, ok: 1 });
    // A valid Date still serializes to its ISO string.
    const d = new Date('2026-07-24T00:00:00.000Z');
    expect(sanitizeForTransport({ when: d })).toEqual({ when: '2026-07-24T00:00:00.000Z' });
  });

  it('a throwing property getter degrades to [UNSERIALIZABLE], not a lost read', () => {
    // MobX strict mode, a Vue reactive read outside a reactive context, a hostile Proxy: a getter
    // can throw. It was dereferenced in an UNGUARDED scalar-vs-collection partition before the
    // per-key try, so one bad property lost the entire object read — the Date bug's twin. One bad
    // getter must cost only its own key; every sibling field must still survive.
    const state = {
      ok: 1,
      get poison(): never {
        throw new Error('getter blew up');
      },
      also: 'here',
    };
    expect(() => sanitizeForTransport(state)).not.toThrow();
    expect(sanitizeForTransport(state)).toEqual({
      ok: 1,
      poison: '[UNSERIALIZABLE]',
      also: 'here',
    });
  });

  it('reads each property getter exactly once (no double side effects)', () => {
    let reads = 0;
    const state = {
      get counted(): number {
        reads += 1;
        return 42;
      },
    };
    sanitizeForTransport(state);
    expect(reads).toBe(1);
  });
});

describe('Map and Set are readable, not silently empty', () => {
  it('a Map serializes to an object of its entries, not {}', () => {
    // The false green this closes: Map has no enumerable own keys, so the plain-object path turned it
    // into {} and an agent read the state as empty when it was merely unrepresentable.
    const store = new Map<string, unknown>([
      ['deploy-1', { status: 'ok' }],
      ['deploy-2', { status: 'failed' }],
    ]);
    expect(sanitizeForTransport(store)).toEqual({
      'deploy-1': { status: 'ok' },
      'deploy-2': { status: 'failed' },
    });
  });

  it('a Set serializes to an array of its members', () => {
    expect(sanitizeForTransport(new Set(['a', 'b', 'c']))).toEqual(['a', 'b', 'c']);
  });

  it('a typed array serializes to an array of its numbers, not an index-keyed object', () => {
    // The false shape this closes: Uint8Array([1,2,3]) fell through to the plain-object path and became
    // {"0":1,"1":2,"2":3}, so an agent reading a binary/tensor field saw an object where an array lives.
    expect(sanitizeForTransport(new Uint8Array([1, 2, 3]))).toEqual([1, 2, 3]);
    expect(sanitizeForTransport({ coords: new Float32Array([1.5, 2.5]) })).toEqual({
      coords: [1.5, 2.5],
    });
  });

  it('a huge typed array is truncated AND the drop is reported', () => {
    const { value, truncation } = sanitizeWithReport(new Uint16Array(1000).fill(7));
    expect((value as number[]).length).toBeLessThan(1000);
    expect(truncation?.droppedItems).toBeGreaterThan(0);
  });

  it('a Map nested in a store is reachable', () => {
    const state = { byId: new Map([['x', 1]]), count: 1 };
    expect(sanitizeForTransport(state)).toEqual({ byId: { x: 1 }, count: 1 });
  });

  it('a huge Map is truncated AND the drop is reported, never silently', () => {
    const big = new Map(Array.from({ length: 1000 }, (_, i) => [`k${i}`, i]));
    const { value, truncation } = sanitizeWithReport(big);
    expect(Object.keys(value as object).length).toBeLessThan(1000);
    expect(truncation?.droppedItems).toBeGreaterThan(0);
  });
});
