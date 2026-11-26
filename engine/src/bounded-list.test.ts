import { describe, expect, it } from 'vitest';
import { boundedList, DETAIL_LABEL_LIMIT, DETAIL_LIST_LIMIT, urlPrefix } from './bounded-list.js';

describe('boundedList', () => {
  it('joins a list at or under the limit whole, with nothing omitted', () => {
    const list = Array.from({ length: DETAIL_LIST_LIMIT }, (_, i) => ({
      label: `u${String(i)}`,
      group: 'g',
    }));
    expect(boundedList(list, '; ')).toEqual({
      text: list.map((e) => e.label).join('; '),
      omitted: 0,
      clipped: false,
    });
  });

  it('declares the loss when it groups or cuts: omitted counts every entry it does not name', () => {
    const list = ['a', 'b', 'c', 'd', 'e', 'f'].map((label) => ({ label, group: 'g' }));
    expect(boundedList(list, ', ')).toEqual({
      text: 'a and 5 more under g',
      omitted: 5,
      clipped: false,
    });
  });

  it('names the first entry of each of the first groups, and counts the groups past the limit', () => {
    const list = Array.from({ length: DETAIL_LIST_LIMIT + 2 }, (_, i) => ({
      label: `x${String(i)}`,
      group: `g${String(i)}`,
    }));
    const out = boundedList(list, '; ');
    expect(out.omitted).toBe(2);
    expect(out.text.endsWith('; and 2 more')).toBe(true);
  });

  it('returns an empty text for an empty list', () => {
    expect(boundedList([], '; ')).toEqual({ text: '', omitted: 0, clipped: false });
  });

  it('names a `first` group even when more than the limit of groups came before it', () => {
    const reads = Array.from({ length: DETAIL_LIST_LIMIT + 1 }, (_, i) => ({
      label: `read${String(i)}`,
      group: `r${String(i)}`,
    }));
    const out = boundedList([...reads, { label: 'write', group: 'w', first: true }], '; ');
    expect(out.text.startsWith('write; read0')).toBe(true);
    expect(out.omitted).toBe(2);
  });

  it('keeps a short list in its own order, `first` or not', () => {
    const list = [
      { label: 'a', group: 'a' },
      { label: 'b', group: 'b', first: true },
    ];
    expect(boundedList(list, '; ').text).toBe('a; b');
  });

  it('clips a name past the label limit and says so', () => {
    const long = 'x'.repeat(DETAIL_LABEL_LIMIT * 100);
    const out = boundedList([{ label: long, group: 'g' }], '; ');
    expect(out.text.length).toBe(DETAIL_LABEL_LIMIT + 1);
    expect(out.clipped).toBe(true);
    expect(out.omitted).toBe(0);
    expect(boundedList([{ label: 'x'.repeat(DETAIL_LABEL_LIMIT), group: 'g' }], '; ').clipped).toBe(
      false,
    );
  });
});

describe('urlPrefix', () => {
  it('keeps the origin and the first path segment', () => {
    expect(urlPrefix('https://tiles.example.com/12/2048/1361.png')).toBe(
      'https://tiles.example.com/12/',
    );
  });
  it('reads a path with no origin', () => {
    expect(urlPrefix('/api/v1/items?id=3')).toBe('/api/');
  });
  it('keeps a bare origin and a one-segment path', () => {
    expect(urlPrefix('https://example.com')).toBe('https://example.com/');
    expect(urlPrefix('https://example.com/robots.txt')).toBe('https://example.com/robots.txt');
  });
  it('returns text that is not a URL as it is', () => {
    expect(urlPrefix('')).toBe('');
    expect(urlPrefix('ipc:save-file')).toBe('ipc:save-file');
  });
});
