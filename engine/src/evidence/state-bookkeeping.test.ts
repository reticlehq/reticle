import { describe, expect, it } from 'vitest';
import { isCacheBookkeepingDiff } from './state-bookkeeping.js';

const entry = (over: Record<string, unknown> = {}) => ({
  status: 'success',
  fetchStatus: 'idle',
  isStale: false,
  dataUpdatedAt: 1,
  error: null,
  data: { plan: 'trial' },
  ...over,
});

describe('meaningful state vs cache bookkeeping', () => {
  it('a fetch cycle that moved only the cache clock is bookkeeping', () => {
    expect(isCacheBookkeepingDiff(entry(), entry({ fetchStatus: 'fetching' }))).toBe(true);
    expect(isCacheBookkeepingDiff(entry(), entry({ isStale: true, dataUpdatedAt: 2 }))).toBe(true);
    expect(isCacheBookkeepingDiff(entry({ status: 'pending' }), entry())).toBe(true);
  });

  it('a data change is meaningful, even when the bookkeeping moved with it', () => {
    expect(
      isCacheBookkeepingDiff(entry(), entry({ data: { plan: 'pro' }, dataUpdatedAt: 2 })),
    ).toBe(false);
  });

  it('an error is meaningful', () => {
    expect(isCacheBookkeepingDiff(entry(), entry({ error: 'boom', status: 'error' }))).toBe(false);
  });

  it('a key the list does not name is meaningful — the unknown is never noise', () => {
    expect(isCacheBookkeepingDiff({ a: 1, status: 'x' }, { a: 1, status: 'y', b: 2 })).toBe(false);
  });

  it('primitives, arrays, appearance and no-op pairs are never bookkeeping', () => {
    expect(isCacheBookkeepingDiff('idle', 'fetching')).toBe(false);
    expect(isCacheBookkeepingDiff([1], [2])).toBe(false);
    expect(isCacheBookkeepingDiff(undefined, entry())).toBe(false);
    expect(isCacheBookkeepingDiff(entry(), entry())).toBe(false);
  });
});
