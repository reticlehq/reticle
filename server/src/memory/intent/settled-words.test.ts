/**
 * From a persona drive: Bea, a maintainer, kept "Orders over $75 ship free" and set aside Ana's
 * "Orders of $50 or more ship free". Ana's own record still said $50, agreed, and her daemon re-sent
 * it every minute, so the decision had to be made three times. A decision made on the dashboard is
 * brought down to the author's record.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeFileSystem } from '@/memory/project/fs/fs-port.js';
import { IntentShardStore } from './intent-shard-store.js';
import { IntentState } from '@reticlehq/core';
import { IntentStatus } from './intent-shard.js';
import { applySettledWords, keptWordsInRequest, settledWordsIn } from './settled-words.js';

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
      binding: { kind: 'text', contains: 'Order 2041' },
    });
    expect(await applySettledWords(store, settledWordsIn([entry]))).toBe(1);
    const after = await store.get('shipping-free');
    expect(after?.statement).toBe('Orders over $75 ship free');
    expect(after?.source).toContain('bea@example.com');
    // The check bound to the old words proves nothing about the kept ones.
    expect(after?.binding).toBeUndefined();
    expect(await applySettledWords(store, settledWordsIn([entry]))).toBe(0);
  });

  // A re-drive: the record then said `state: "bound"` with no binding, so a check naming it proved
  // nothing and said nothing. With its check gone, it is declared again, and asks to be bound.
  it('is declared again, not bound, once its check is taken off', async () => {
    await store.upsert(
      'shipping-free',
      () => ({
        id: 'shipping-free',
        statement: 'Orders of $50 or more ship free',
        state: IntentState.BOUND,
        declaredAt: 1,
        binding: { kind: 'text', contains: 'Order 2041' },
      }),
      { status: IntentStatus.AGREED },
    );
    await applySettledWords(store, settledWordsIn([entry]));
    const after = await store.get('shipping-free');
    expect(after?.binding).toBeUndefined();
    expect(after?.state).toBe(IntentState.DECLARED);
  });

  /*
   * Re-drive (persona 21): Bea chose Carl's words, which named `src/views/SavedItems.tsx`. Her own
   * record took the words but kept the files of the words set aside (none), her daemon re-sent it,
   * and the platform's file was gone 50 s later — so `reticle_memory` answered `sourceFile: null`.
   * The kept words come down with the file the platform holds for them.
   */
  it('takes the file the platform holds for the kept words', async () => {
    await store.record({
      id: 'shipping-free',
      statement: 'Orders of $50 or more ship free',
      status: IntentStatus.AGREED,
      surface: { route: '/cart', files: ['src/old-cart.tsx'] },
    });
    const withFile = { ...entry, sourceFile: 'src/views/SavedItems.tsx' };
    await applySettledWords(store, settledWordsIn([withFile]));
    const after = await store.get('shipping-free');
    expect(after?.surface).toEqual({ route: '/cart', files: ['src/views/SavedItems.tsx'] });
  });

  /*
   * Persona drive: Bea chose Carl's words ("Use proposed", now agreed); Carl's own daemon still held
   * them as `proposed`, re-sent them every ~5 s, and the platform took the author's copy — undoing
   * her decision. A status the team settled is brought down to the record holding the same words.
   */
  it("raises the author's record to the status the team settled on its words", async () => {
    await store.record({
      id: 'saved',
      statement: 'Saving adds it to the top',
      status: IntentStatus.PROPOSED,
    });
    const agreed = { statement: 'Saving adds it to the top', status: 'agreed' };
    expect(await applySettledWords(store, settledWordsIn([agreed]))).toBe(1);
    expect((await store.get('saved'))?.status).toBe(IntentStatus.AGREED);
    expect(await applySettledWords(store, settledWordsIn([agreed]))).toBe(0);
    // Never lowered: a record this machine proved stays proved.
    await store.record({ id: 'p', statement: 'Proved here', status: IntentStatus.PROVED });
    await applySettledWords(
      store,
      settledWordsIn([{ statement: 'Proved here', status: 'agreed' }]),
    );
    expect((await store.get('p'))?.status).toBe(IntentStatus.PROVED);
  });

  /*
   * Persona drive: the run that proved the ACCEPTED words listed the words that were set aside as
   * its goal ("What was asked"), because the agent's declared request still held them.
   */
  it('puts the kept words in the request a run reports, in place of the words set aside', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reticle-settled-req-'));
    await mkdir(root, { recursive: true });
    const path = join(root, 'request.json');
    await writeFile(
      path,
      JSON.stringify({
        at: 1,
        statements: [{ text: 'Orders of $50 or more ship free', kind: 'goal', source: 'agent' }],
      }),
    );
    await keptWordsInRequest(path, settledWordsIn([entry]));
    expect(await readFile(path, 'utf8')).toContain('Orders over $75 ship free');
    expect(await readFile(path, 'utf8')).not.toContain('$50 or more');
  });
});
