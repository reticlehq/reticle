import { describe, expect, it } from 'vitest';
import { ContradictionKind, EventType, type ReticleEvent } from '@reticlehq/core';
import { findStalledPagination } from './contradictions.js';

const get = (url: string): ReticleEvent =>
  ({
    type: EventType.NET_REQUEST,
    t: 10,
    data: { method: 'GET', url, status: 200 },
  }) as unknown as ReticleEvent;
const label = (old: string, text: string): ReticleEvent =>
  ({ type: EventType.DOM_TEXT, t: 11, data: { text, old } }) as unknown as ReticleEvent;

/** From a payments dashboard: "Next" relabels the table "Page 2" and refetches page=1. */
describe('a page label that moved while the request did not', () => {
  const firstPage = get('/api/v1/payments?page=1&status=all');

  it('is found when the same page is asked for again', () => {
    const found = findStalledPagination(
      [label('Page 1 of 6', 'Page 2 of 6'), get('/api/v1/payments?status=all&page=1')],
      [firstPage],
    );
    expect(found.map((f) => f.kind)).toEqual([ContradictionKind.PAGINATION_NOT_FETCHED]);
    expect(found[0]?.counter).toContain('page=1');
  });

  it('is found when only the cache-buster changed', () => {
    const found = findStalledPagination(
      [label('Page 1 of 6', 'Page 2 of 6'), get('/api/v1/payments?page=1&status=all&_=1705')],
      [get('/api/v1/payments?page=1&status=all&_=1699')],
    );
    expect(found.map((f) => f.kind)).toEqual([ContradictionKind.PAGINATION_NOT_FETCHED]);
  });

  it('is not found when the next page was asked for', () => {
    expect(
      findStalledPagination(
        [label('Page 1 of 6', 'Page 2 of 6'), get('/api/v1/payments?page=2&status=all')],
        [firstPage],
      ),
    ).toEqual([]);
  });

  it('is not found when nothing was fetched: paging rows already loaded is legitimate', () => {
    expect(findStalledPagination([label('Page 1 of 6', 'Page 2 of 6')], [firstPage])).toEqual([]);
  });

  it('is not found when a records range changes', () => {
    for (const range of [
      '1-200 of 5,298 records',
      '1 – 200 of 5,298 records',
      '1 to 200 of 5,298 records',
      'Showing 1,234 of 5,298 records',
    ]) {
      expect(
        findStalledPagination(
          [label(range, '0 of 0 records'), get('/api/v1/payments?offset=0&status=all')],
          [get('/api/v1/payments?offset=0&status=all')],
        ),
      ).toEqual([]);
    }
  });

  it('is not found when a count starts at zero and a list refetches its first page', () => {
    // Field report: "0 of 4 generated" became "1 of 4 generated" as an asset finished, and the
    // members list refreshed offset=0. No paging action happened; the verdict read `no`.
    const counts: readonly (readonly [string, string])[] = [
      ['0 of 4 generated', '1 of 4 generated'],
      ['0 / 4', '1 / 4'],
      ['1 of 4', '0 of 4'],
    ];
    for (const [before, after] of counts) {
      expect(
        findStalledPagination(
          [label(before, after), get('/api/v1/members?offset=0&limit=50')],
          [get('/api/v1/members?offset=0&limit=50')],
        ),
      ).toEqual([]);
    }
  });

  it('is still found for a bare "N of M" page label that moved from page 1', () => {
    const found = findStalledPagination(
      [label('1 of 6', '2 of 6'), get('/api/v1/payments?page=1&status=all')],
      [firstPage],
    );
    expect(found.map((f) => f.kind)).toEqual([ContradictionKind.PAGINATION_NOT_FETCHED]);
  });

  it('is not found when a search starts a new result set at the same offset', () => {
    expect(
      findStalledPagination(
        [label('Page 1 of 6', 'Page 2 of 6'), get('/api/v1/payments?limit=200&offset=0&q=abc')],
        [get('/api/v1/payments?limit=200&offset=0')],
      ),
    ).toEqual([]);
  });
});
