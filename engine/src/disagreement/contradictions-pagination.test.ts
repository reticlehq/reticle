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
      [label('Page 1 of 6', 'Page 2 of 6'), get('/api/v1/payments?page=1&status=all')],
      [firstPage],
    );
    expect(found.map((f) => f.kind)).toEqual([ContradictionKind.PAGINATION_NOT_FETCHED]);
    expect(found[0]?.counter).toContain('page=1');
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
});
