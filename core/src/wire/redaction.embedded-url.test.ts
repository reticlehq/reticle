import { describe, expect, it } from 'vitest';
import { netUrlFields, redactUrl } from './redaction.js';

describe('embedded URL diagnostics', () => {
  it('keeps the media type while bounding a base64 data URL', () => {
    const raw = `data:image/png;base64,${'A'.repeat(48_219)}`;
    const summarized = redactUrl(raw);

    expect(summarized).toBe('data:image/png;base64,<…48219 bytes…>');
    expect(summarized.length).toBeLessThan(80);
    expect(summarized).not.toContain('AAAA');
  });

  it('uses the default media type and counts UTF-8 payload bytes', () => {
    expect(redactUrl('data:,✓')).toBe('data:text/plain,<…3 bytes…>');
  });

  it('bounds malformed metadata instead of repeating it', () => {
    const raw = `data:${'x'.repeat(10_000)},payload`;
    expect(redactUrl(raw)).toBe('data:text/plain,<…7 bytes…>');
  });

  it('leaves blob URLs unchanged because they do not contain the blob payload', () => {
    const raw = 'blob:https://example.test/550e8400-e29b-41d4-a716-446655440000';
    expect(redactUrl(raw)).toBe(raw);
    expect(netUrlFields(raw)).toEqual({ url: raw });
  });

  it('keeps the raw data URL for predicates while bounding the displayed URL', () => {
    const raw = `data:image/webp;base64,${'B'.repeat(50_000)}`;
    const fields = netUrlFields(raw);
    expect(fields).toEqual({
      url: 'data:image/webp;base64,<…50000 bytes…>',
      urlRaw: raw,
    });
  });
});
