import { describe, expect, it } from 'vitest';
import { IntentState } from '@reticlehq/core/artifacts';
import { createMemoryFs } from '@/memory/project/memory-fs.js';
import { IntentStore } from './intent-store.js';

const ROOT = '/repo/apps/web/.reticle';

function store() {
  const { fs, written } = createMemoryFs();
  return { store: new IntentStore(fs, ROOT, { now: () => 1_000 }), written };
}

describe('IntentStore', () => {
  it('reads an empty ledger before anything is written', async () => {
    expect(await store().store.read()).toEqual([]);
  });

  /*
   * A write that dies halfway must not erase the ledger.
   *
   * `#load` fails soft to EMPTY, deliberately and correctly: this is a git-checked file a human can
   * hand-merge, so a conflict marker in it must not take down the verdict that was only asking what
   * was still open. But every mutation is a read-modify-write over that same load. So a truncated
   * file does not degrade - it reads as "no intents were ever declared", and the very next save
   * writes that empty ledger back over the real one. One interrupted write, and a committed,
   * durable record of what the work was supposed to make true is gone for good.
   *
   * Writing to a temp sibling and renaming is what makes the destination hold the old file or the
   * new one and never a half of either.
   */
  it('leaves the previous ledger intact when a write dies halfway', async () => {
    const { fs, written } = createMemoryFs();
    const path = `${ROOT}/intent/unsorted/intent.json`;
    const clock = { now: (): number => 1_000 };
    await new IntentStore(fs, ROOT, clock).declare([{ id: 'a', statement: 'A' }]);
    const intact = written.get(path);

    // The disk fills, or the process dies, after the bytes are partly down.
    const dying = {
      ...fs,
      writeFile: async (p: string, data: string): Promise<void> => {
        await fs.writeFile(p, data.slice(0, 12));
        throw new Error('ENOSPC: no space left on device');
      },
    };
    await new IntentStore(dying, ROOT, clock)
      .declare([{ id: 'b', statement: 'B' }])
      .catch(() => undefined);

    expect(written.get(path)).toBe(intact);
    expect(await new IntentStore(fs, ROOT, clock).read()).toHaveLength(1);
  });

  it('writes into the project it was given, not somewhere else', async () => {
    const { store: s, written } = store();
    await s.declare([{ id: 'a', statement: 'A' }]);
    expect([...written.keys()].some((p) => p.startsWith(ROOT))).toBe(true);
  });

  it('round-trips a declared intent', async () => {
    const { store: s } = store();
    await s.declare([{ id: 'a', statement: 'users can check in' }]);
    const [intent] = await s.read();
    expect(intent?.statement).toBe('users can check in');
    expect(intent?.state).toBe(IntentState.DECLARED);
    expect(intent?.declaredAt).toBe(1_000);
  });

  it('declares several in one call, because one per feature is the budget', async () => {
    const { store: s } = store();
    await s.declare([
      { id: 'a', statement: 'A' },
      { id: 'b', statement: 'B' },
    ]);
    expect((await s.read()).map((i) => i.id).sort()).toEqual(['a', 'b']);
  });

  it('binds a predicate to an existing intent', async () => {
    const { store: s } = store();
    await s.declare([{ id: 'a', statement: 'A' }]);
    expect(await s.bind('a', { kind: 'text', value: 'checked in' })).toBe(true);
    const [intent] = await s.read();
    expect(intent?.state).toBe(IntentState.BOUND);
  });

  it('says so rather than inventing an intent when the id is unknown', async () => {
    const { store: s } = store();
    expect(await s.bind('nobody', { kind: 'text' })).toBe(false);
    expect(await s.read()).toEqual([]);
  });

  /**
   * The re-run case, and the reason amendments are append-only: a long build re-declares, and the
   * ledger has to keep what was previously meant so a narrowing is visible in review.
   */
  it('keeps the previous statement when an intent is re-declared differently', async () => {
    const { store: s } = store();
    await s.declare([{ id: 'a', statement: 'first' }]);
    await s.declare([{ id: 'a', statement: 'second' }]);
    const [intent] = await s.read();
    expect(intent?.statement).toBe('second');
    expect(intent?.amended).toEqual([{ statement: 'first', at: 1_000 }]);
  });

  /**
   * Fails soft, deliberately. This is a git-checked file an agent can edit and a human can
   * hand-merge, so a malformed one is reachable — and taking a verdict down over it would trade a
   * small problem for a large one.
   */
  it('reads an unparseable ledger as empty rather than throwing', async () => {
    const { fs, written } = createMemoryFs();
    written.set(`${ROOT}/intent.json`, '{ this is not json');
    const s = new IntentStore(fs, ROOT, { now: () => 1 });
    await expect(s.read()).resolves.toEqual([]);
  });

  it('survives a ledger that parses but is the wrong shape', async () => {
    const { fs, written } = createMemoryFs();
    written.set(`${ROOT}/intent.json`, JSON.stringify({ version: 1, intents: { a: {} } }));
    const s = new IntentStore(fs, ROOT, { now: () => 1 });
    await expect(s.read()).resolves.toEqual([]);
  });

  it('reports only what is still open', async () => {
    const { store: s } = store();
    await s.declare([
      { id: 'a', statement: 'A' },
      { id: 'b', statement: 'B' },
    ]);
    await s.bind('b', { kind: 'net' });
    await s.discharge('b', { verdictId: 'v', grade: 'net', at: 2 });
    expect((await s.open()).map((i) => i.id)).toEqual(['a']);
  });

  it('does not discharge an intent that was never bound', async () => {
    const { store: s } = store();
    await s.declare([{ id: 'a', statement: 'A' }]);
    expect(await s.discharge('a', { verdictId: 'v', grade: 'dom', at: 2 })).toBe(false);
    expect((await s.open()).map((i) => i.id)).toEqual(['a']);
  });

  /** Byte-stable, so an unchanged ledger round-trips without churning the diff. */
  it('writes byte-identical content for an unchanged ledger', async () => {
    const { store: s, written } = store();
    await s.declare([{ id: 'a', statement: 'A' }]);
    const first = written.get(`${ROOT}/intent/unsorted/intent.json`);
    await s.declare([{ id: 'a', statement: 'A' }]);
    expect(written.get(`${ROOT}/intent/unsorted/intent.json`)).toBe(first);
  });
});

// The whole story a saved flow lives through: declared, bound, proved by a replay, then the flow is
// re-saved — which re-declares its intent and re-binds it. The proof must still be there after.
describe('re-saving a flow does not erase what it proved', () => {
  it('keeps a proved intent proved through a re-declare and a re-bind', async () => {
    const { store: s } = store();
    await s.declare([{ id: 'pay', statement: 'paying charges the card once' }]);
    await s.bind('pay', { flow: 'pay' });
    await s.discharge('pay', { verdictId: 'v1', grade: 'flow', at: 5 });

    await s.declare([
      { id: 'pay', statement: 'paying charges the card once', surface: { flow: 'pay' } },
    ]);
    await s.bind('pay', { flow: 'pay' });

    const [pay] = (await s.read()).filter((i) => 'pay' === i.id);
    expect(pay?.state).toBe(IntentState.PROVED);
    expect(pay?.provenBy).toEqual({ verdictId: 'v1', grade: 'flow', at: 5 });
    expect(pay?.surface).toEqual({ flow: 'pay' });
  });
});

/*
 * The layout: `.reticle/intent/<subject>/intent.json`, one directory per subject, and a flow's name IS
 * its subject. `index.json` beside them is derived. The old single `.reticle/intent.json` is migrated
 * on the first write and removed, so the move shows up in review as one diff.
 */
describe('the intent directory layout', () => {
  const LEGACY = `${ROOT}/intent.json`;
  const shard = (subject: string): string => `${ROOT}/intent/${subject}/intent.json`;
  const idsIn = (written: Map<string, string>, subject: string): string[] =>
    Object.keys(
      (JSON.parse(written.get(shard(subject)) ?? '{"intents":{}}') as { intents: object }).intents,
    );

  it('writes one directory per subject, an index beside them, and no flat file', async () => {
    const { store: s, written } = store();
    await s.declare([{ id: 'a', statement: 'A' }]);
    expect(idsIn(written, 'unsorted')).toEqual(['a']);
    expect(written.has(`${ROOT}/intent/index.json`)).toBe(true);
    expect(written.has(LEGACY)).toBe(false);
  });

  it('files an intent under its flow', async () => {
    const { store: s, written } = store();
    await s.declare([
      { id: 'pay', statement: 'paying charges once', surface: { flow: 'Pay Flow' } },
    ]);
    expect(idsIn(written, 'pay-flow')).toEqual(['pay']);
  });

  it('moves an intent into its flow directory once a flow claims it', async () => {
    const { store: s, written } = store();
    await s.declare([{ id: 'pay', statement: 'paying charges once' }]);
    await s.place('pay', { flow: 'pay-flow' });
    expect(idsIn(written, 'pay-flow')).toEqual(['pay']);
    expect(idsIn(written, 'unsorted')).toEqual([]);
  });

  it('reads the old flat ledger before anything has been written', async () => {
    const { fs, written } = createMemoryFs();
    written.set(
      LEGACY,
      JSON.stringify({
        version: 1,
        intents: { old: { id: 'old', statement: 'O', state: 'declared', declaredAt: 1 } },
      }),
    );
    expect((await new IntentStore(fs, ROOT, { now: () => 2 }).read()).map((i) => i.id)).toEqual([
      'old',
    ]);
  });

  it('migrates the flat ledger on the first write, proof intact, and removes it', async () => {
    const { fs, written } = createMemoryFs();
    const proved = {
      id: 'checkout',
      statement: 'checkout charges once',
      state: 'proved',
      declaredAt: 1,
      surface: { flow: 'checkout' },
      binding: { flow: 'checkout' },
      provenBy: { verdictId: 'v1', grade: 'flow', at: 3 },
    };
    written.set(LEGACY, JSON.stringify({ version: 1, intents: { checkout: proved } }));
    const s = new IntentStore(fs, ROOT, { now: () => 5 });
    await s.declare([{ id: 'new', statement: 'N' }]);
    expect(written.has(LEGACY)).toBe(false);
    expect(idsIn(written, 'checkout')).toEqual(['checkout']);
    const [kept] = (await s.read()).filter((i) => 'checkout' === i.id);
    expect(kept?.state).toBe(IntentState.PROVED);
    expect(kept?.provenBy).toEqual(proved.provenBy);
    expect((await s.read()).map((i) => i.id).sort()).toEqual(['checkout', 'new']);
  });

  // A hand-merged ledger with a conflict marker reads as empty. Deleting it would destroy the only
  // copy of every intent in it, so a flat file that does not parse is never removed.
  it('never removes a flat ledger it could not parse', async () => {
    const { fs, written } = createMemoryFs();
    written.set(LEGACY, '<<<<<<< HEAD\n{ "intents": {} }');
    await new IntentStore(fs, ROOT, { now: () => 5 }).declare([{ id: 'n', statement: 'N' }]);
    expect(written.has(LEGACY)).toBe(true);
  });
});
