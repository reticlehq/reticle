import { describe, expect, it } from 'vitest';
import { asRecord, isPlainRecord } from './narrow.js';

describe('isPlainRecord', () => {
  it('accepts an object with keys to read', () => {
    expect(isPlainRecord({})).toBe(true);
    expect(isPlainRecord({ verified: 'proved' })).toBe(true);
  });

  it('rejects an array, which asRecord lets through', () => {
    expect(isPlainRecord([])).toBe(false);
    expect(isPlainRecord([{ verified: 'proved' }])).toBe(false);
    expect(asRecord([])).toEqual([]);
  });

  it('rejects null and every primitive', () => {
    for (const value of [null, undefined, 'object', 0, true]) {
      expect(isPlainRecord(value)).toBe(false);
    }
  });
});
