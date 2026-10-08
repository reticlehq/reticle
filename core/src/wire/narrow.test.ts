import { describe, expect, it } from 'vitest';
import { asRecord, isPlainRecord, originOf, pathOf } from './narrow.js';

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

describe('originOf and pathOf', () => {
  it('read the origin and pathname the URL parser reports', () => {
    expect(originOf('http://localhost:5173/cart?x=1#top')).toBe('http://localhost:5173');
    expect(originOf('https://example.com:443/a')).toBe('https://example.com');
    expect(originOf('http://[::1]:4400/x')).toBe('http://[::1]:4400');
    expect(originOf('file:///tmp/index.html')).toBe('null');
    expect(pathOf('http://localhost:5173/cart?x=1#top')).toBe('/cart');
    expect(pathOf('http://[::1]:4400')).toBe('/');
    expect(pathOf('file:///tmp/index.html')).toBe('/tmp/index.html');
  });

  it('answer nothing for an absent or unparseable URL', () => {
    for (const url of [undefined, '', 'example.com/cart', '/cart', 'http://', 'http://a b']) {
      expect(originOf(url)).toBeUndefined();
    }
    expect(pathOf(undefined)).toBeUndefined();
    expect(pathOf('/cart')).toBeUndefined();
    expect(pathOf('http://')).toBeUndefined();
  });
});
