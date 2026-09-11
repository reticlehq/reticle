import { describe, expect, it } from 'vitest';
import { IntentState } from '@reticlehq/core/artifacts';
import { createMemoryFs } from '../project/memory-fs.js';
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
    const first = written.get(`${ROOT}/intent.json`);
    await s.declare([{ id: 'a', statement: 'A' }]);
    expect(written.get(`${ROOT}/intent.json`)).toBe(first);
  });
});
