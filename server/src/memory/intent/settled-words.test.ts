/**
 * From a persona drive: Bea, a maintainer, kept "Orders over $75 ship free" and set aside Ana's
 * "Orders of $50 or more ship free". Ana's own record still said $50, agreed, and her daemon re-sent
 * it every minute, so the decision had to be made three times. A decision made on the dashboard is
 * brought down to the author's record.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeFileSystem } from '@/memory/project/fs/fs-port.js';
import { IntentShardStore } from './intent-shard-store.js';
import { IntentStatus } from './intent-shard.js';
import { applySettledWords, settledWordsIn } from './settled-words.js';

const fs = createNodeFileSystem();
const clock = { now: () => 1_700_000_000_000 };
let store: IntentShardStore;
beforeEach(async () => {
  store = new IntentShardStore(
    fs,
    join(await mkdtemp(join(tmpdir(), 'reticle-settled-')), '.reticle'),
    clock,
  );
});

const entry = {
  statement: 'Orders over $75 ship free',
  decisions: [
    {
      at: 1,
      byEmail: 'bea@example.com',
      kept: 'current',
      setAside: { statement: 'Orders of $50 or more ship free', byEmail: 'ana@example.com' },
    },
  ],
};

describe('a decision made on the dashboard', () => {
  it('is read off the memory entries the platform returns', () => {
    expect(settledWordsIn([entry, { statement: 'x' }, null])).toEqual([
      {
        kept: 'Orders over $75 ship free',
        setAside: 'Orders of $50 or more ship free',
        by: 'bea@example.com',
      },
    ]);
  });

  it('changes the author’s record to the words kept, and says who decided', async () => {
    await store.record({
      id: 'shipping-free',
      statement: 'Orders of $50 or more ship free',
      status: IntentStatus.AGREED,
    });
    expect(await applySettledWords(store, settledWordsIn([entry]))).toBe(1);
    const after = await store.get('shipping-free');
    expect(after?.statement).toBe('Orders over $75 ship free');
    expect(after?.source).toContain('bea@example.com');
    expect(await applySettledWords(store, settledWordsIn([entry]))).toBe(0);
  });
});
