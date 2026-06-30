import { describe, expect, it } from 'vitest';
import { REDACTED_VALUE, TRANSPORT_LIMITS } from '@reticlehq/protocol';
import { safeStringify, sanitizeForTransport } from './serialization.js';

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
    const value: Record<string, unknown> = { count: 2n };
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
