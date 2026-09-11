import { afterEach, describe, expect, it } from 'vitest';
import { TRANSPORT_LIMITS } from '@reticlehq/core';
import { sanitizeWithReport, sanitizeForTransport, safeStringify } from './serialization.js';
import {
  readStores,
  readStoresRaw,
  readStoresWithTruncation,
  registerStore,
  unregisterStore,
} from '../registry/stores.js';

/**
 * Conformance half of the lossy-transform invariant, for the transforms that live in the browser SDK.
 *
 *   Any transform that can drop, truncate, or shape-coerce data on a path an agent reads must
 *   report that it did, in a machine-readable way the consumer can detect.
 *
 * Each case drives a fixture GUARANTEED to lose data. The completeness half — that every export of a
 * read-path module has been classified at all — is `scripts/check-lossy-transforms.mjs` in `pnpm lint`.
 */

const STORE = 'lossy-conformance';

afterEach(() => {
  unregisterStore(STORE);
});

function bigArray(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}

describe('sanitizeWithReport is the reference implementation', () => {
  it('reports dropped items when a collection exceeds the cap', () => {
    const { value, truncation } = sanitizeWithReport({
      items: bigArray(TRANSPORT_LIMITS.MAX_COLLECTION_ITEMS * 3),
    });
    expect((value as { items: number[] }).items.length).toBeLessThan(
      TRANSPORT_LIMITS.MAX_COLLECTION_ITEMS * 3,
    );
    expect(truncation?.droppedItems).toBeGreaterThan(0);
    expect(truncation?.note).toContain('NOT the whole value');
  });

  it('reports a truncated VALUE, not only dropped items', () => {
    const { truncation } = sanitizeWithReport({
      blob: 'x'.repeat(TRANSPORT_LIMITS.MAX_STRING_LENGTH * 2),
    });
    expect(truncation?.truncatedValues).toBeGreaterThan(0);
  });

  it('reports dropped KEYS, so a 5,000-key store is not handed back as if it had 200', () => {
    const wide: Record<string, number> = {};
    for (let i = 0; i < TRANSPORT_LIMITS.MAX_OBJECT_KEYS * 4; i++) wide[`k${String(i)}`] = i;
    expect(sanitizeWithReport(wide).truncation?.droppedItems).toBeGreaterThan(0);
  });

  it('declares nothing when nothing was lost — the report must MEAN something', () => {
    expect(sanitizeWithReport({ a: 1, b: [1, 2, 3] }).truncation).toBeUndefined();
  });
});

describe('the wrappers that DISCARD the report are honest about being wrappers', () => {
  // Registered SILENT in scripts/check-lossy-transforms.mjs. Pinned here so the gap is a documented
  // fact with a test behind it rather than a thing someone has to notice.
  it('sanitizeForTransport returns the same value, minus any way to know it was cut', () => {
    const input = { items: bigArray(TRANSPORT_LIMITS.MAX_COLLECTION_ITEMS * 3) };
    const reported = sanitizeWithReport(input);
    expect(reported.truncation).toBeDefined();
    expect(sanitizeForTransport(input)).toEqual(reported.value);
  });

  it('safeStringify inherits that, and additionally collapses an unserializable value', () => {
    const hostile = {
      get boom(): never {
        throw new Error('nope');
      },
    };
    expect(safeStringify(hostile)).toContain('UNSERIALIZABLE');
  });
});

describe('readStoresWithTruncation declares loss per store', () => {
  it('names WHICH store came back incomplete, not merely that something did', () => {
    registerStore(STORE, () => ({ rows: bigArray(TRANSPORT_LIMITS.MAX_COLLECTION_ITEMS * 3) }));
    const { stores, truncation } = readStoresWithTruncation(STORE);

    expect(stores[STORE]).toBeDefined();
    expect(truncation?.[STORE]?.droppedItems).toBeGreaterThan(0);
  });

  it('omits the report entirely when every store came back whole', () => {
    registerStore(STORE, () => ({ n: 1 }));
    expect(readStoresWithTruncation(STORE).truncation).toBeUndefined();
  });

  it('readStores is the same value with the report dropped — the registered SILENT wrapper', () => {
    registerStore(STORE, () => ({ rows: bigArray(TRANSPORT_LIMITS.MAX_COLLECTION_ITEMS * 3) }));
    expect(readStores(STORE)).toEqual(readStoresWithTruncation(STORE).stores);
  });

  it('readStoresRaw is uncapped by design, which is why the scoped read selects from it', () => {
    const rows = bigArray(TRANSPORT_LIMITS.MAX_COLLECTION_ITEMS * 3);
    registerStore(STORE, () => ({ rows }));
    expect((readStoresRaw(STORE)[STORE] as { rows: number[] }).rows.length).toBe(rows.length);
  });
});

// `Transport`'s side of the invariant — a full offline queue evicting events and declaring the gap
// with TRANSPORT_OVERFLOW — is proven in transport.overflow-marker.test.ts, which is registered as a
// conformance suite in scripts/check-lossy-transforms.mjs. That suite predates the registry and its
// whole subject is the declared gap; copying it here would be worse coverage, not more.
