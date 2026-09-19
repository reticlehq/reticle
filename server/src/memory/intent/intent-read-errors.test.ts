/** Regression for #994: an unreadable ledger must never become an empty writable ledger. */
import { describe, expect, it } from 'vitest';
import { createMemoryFs } from '@/memory/project/memory-fs.js';
import { IntentStore } from './intent-store.js';
import { IntentShardStore } from './intent-shard-store.js';

const ROOT = '/repo/.reticle';
const FLAT = `${ROOT}/intent.json`;
const SHARD = `${ROOT}/intent/checkout.json`;
const CLOCK = { now: () => 1_000 };
const ENTRY = { id: 'checkout', statement: 'checkout persists the order', subject: 'checkout' };
const INVALID_DOCUMENTS = [
  '{ unresolved conflict',
  JSON.stringify({ version: 1, intents: { previous: { statement: 'keep me' } } }),
];

const MUTATIONS: { name: string; run: (store: IntentStore) => Promise<unknown> }[] = [
  { name: 'declare', run: (store) => store.declare([ENTRY]) },
  { name: 'bind', run: (store) => store.bind('previous', { kind: 'text', text: 'Saved' }) },
  { name: 'place', run: (store) => store.place('previous', { route: '/checkout' }) },
  {
    name: 'discharge',
    run: (store) => store.discharge('previous', { verdictId: 'verdict', grade: 'dom', at: 2_000 }),
  },
];

describe('intent persistence refuses unreadable source documents', () => {
  it.each(INVALID_DOCUMENTS)('keeps an invalid flat ledger byte-for-byte: %s', async (content) => {
    for (const mutation of MUTATIONS) {
      const { fs, written } = createMemoryFs();
      written.set(FLAT, content);
      const store = new IntentStore(fs, ROOT, CLOCK);
      await expect(mutation.run(store), mutation.name).rejects.toThrow();
      expect([...written], mutation.name).toEqual([[FLAT, content]]);
    }
  });

  it.each(INVALID_DOCUMENTS)(
    'refuses shard writes and migration over an invalid legacy file: %s',
    async (content) => {
      const { fs, written } = createMemoryFs();
      written.set(FLAT, content);
      const store = new IntentShardStore(fs, ROOT, CLOCK);
      await expect(store.record(ENTRY)).rejects.toThrow();
      await expect(store.migrate()).rejects.toThrow();
      await expect(store.index()).rejects.toThrow();
      expect([...written]).toEqual([[FLAT, content]]);
    },
  );

  it.each(INVALID_DOCUMENTS)(
    'refuses to replace an invalid existing shard: %s',
    async (content) => {
      const { fs, written } = createMemoryFs();
      written.set(SHARD, content);
      const store = new IntentShardStore(fs, ROOT, CLOCK);
      await expect(store.record(ENTRY)).rejects.toThrow();
      await expect(store.get(ENTRY.id)).rejects.toThrow();
      expect([...written]).toEqual([[SHARD, content]]);
    },
  );

  it.each(['EACCES', 'EIO'])(
    'does not interpret a %s read failure as an absent ledger',
    async (code) => {
      const { fs, written } = createMemoryFs();
      const failure = Object.assign(new Error('ledger read failed'), { code });
      const failingFs = {
        ...fs,
        readFile: () => Promise.reject(failure),
      };
      const flat = new IntentStore(failingFs, ROOT, CLOCK);
      const shards = new IntentShardStore(failingFs, ROOT, CLOCK);
      await expect(flat.declare([ENTRY])).rejects.toBe(failure);
      await expect(flat.read()).rejects.toBe(failure);
      await expect(shards.record(ENTRY)).rejects.toBe(failure);
      expect(written.size).toBe(0);
    },
  );

  it('does not write a partial index when the shard directory cannot be listed', async () => {
    const { fs, written } = createMemoryFs();
    const failure = Object.assign(new Error('directory read failed'), { code: 'EACCES' });
    const store = new IntentShardStore(
      {
        ...fs,
        readdir: () => Promise.reject(failure),
      },
      ROOT,
      CLOCK,
    );
    await expect(store.record(ENTRY)).rejects.toBe(failure);
    await expect(store.index()).rejects.toBe(failure);
    expect(written.size).toBe(0);
  });

  it('still creates genuinely missing flat and sharded ledgers', async () => {
    const { fs } = createMemoryFs();
    const flat = new IntentStore(fs, ROOT, CLOCK);
    expect(await flat.read()).toEqual([]);
    await flat.declare([{ id: 'previous', statement: 'a sibling intent' }]);
    const shards = new IntentShardStore(fs, ROOT, CLOCK);
    await shards.record(ENTRY);
    expect((await shards.all()).map((entry) => entry.id).sort()).toEqual(['checkout', 'previous']);
  });
});
