import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeFileSystem } from '@/memory/project/fs/fs-port.js';
import {
  LedgerStore,
  acceptCurrent,
  emptyLedger,
  levelsOf,
  mergeLedger,
  raiseBest,
  regressions,
  staleChanged,
  unexecutedChanged,
} from './ledger.js';

/*
 * "Done" was the agent's opinion. The ledger makes it a number per level with the missing items
 * named, accumulated across every drive, so "covered everything" can be checked rather than claimed.
 */
describe('levelsOf', () => {
  const ledger = mergeLedger(emptyLedger(), {
    routes: { discovered: ['/', '/cart', '/admin'], reached: ['/', '/cart'] },
    controls: {
      seen: ['button "Add"', 'button "Pay"', 'button "Refund"'],
      touched: ['button "Add"', 'button "Pay"'],
      proved: ['button "Add"'],
    },
    writes: {
      seen: ['POST /api/pay', 'POST /api/refund'],
      branched: ['POST /api/pay'],
      unhandled: [],
    },
    code: {
      'src/Cart.tsx': {
        'add@1': { name: 'add', executed: true },
        'refund@9': { name: 'refund', executed: false },
      },
    },
  });
  const byName = Object.fromEntries(levelsOf(ledger).map((l) => [l.level, l]));

  it('reports each level separately, with what is missing named', () => {
    expect(byName['reached']).toMatchObject({ covered: 2, total: 3, pct: 67, missing: ['/admin'] });
    expect(byName['touched']).toMatchObject({ covered: 2, total: 3, missing: ['button "Refund"'] });
    expect(byName['proved']).toMatchObject({ covered: 1, total: 3 });
    expect(byName['branched']).toMatchObject({
      covered: 1,
      total: 2,
      missing: ['POST /api/refund'],
    });
    expect(byName['executed']).toMatchObject({
      covered: 1,
      total: 2,
      missing: ['src/Cart.tsx: refund'],
    });
  });

  it('never reports a percentage it did not measure', () => {
    const empty = Object.fromEntries(levelsOf(emptyLedger()).map((l) => [l.level, l]));
    expect(empty['reached']?.pct).toBeUndefined();
    expect(empty['completed']?.pct).toBeUndefined();
  });
});

describe('mergeLedger', () => {
  it('only ever adds: a later drive cannot un-cover something', () => {
    const a = mergeLedger(emptyLedger(), { controls: { seen: ['x'], touched: ['x'], proved: [] } });
    const b = mergeLedger(a, { controls: { seen: ['x', 'y'], touched: [], proved: [] } });
    expect(b.controls).toEqual({ seen: ['x', 'y'], touched: ['x'], proved: [] });
  });
});

describe('the ratchet', () => {
  it('names a level whose coverage fell below the best it ever reached', () => {
    const covered = mergeLedger(emptyLedger(), {
      writes: { seen: ['POST /a'], branched: ['POST /a'], unhandled: [] },
    });
    const best = raiseBest(covered);
    // A new write appears and nobody drove its failure path: 100% -> 50%.
    const grown = mergeLedger(best, { writes: { seen: ['POST /b'], branched: [], unhandled: [] } });
    expect(regressions(grown)).toEqual([{ level: 'branched', was: 100, now: 50 }]);
    // Raising the best never lowers it, so recording the drop does not forgive it...
    expect(regressions(raiseBest(grown))).toHaveLength(1);
    // ...only covering the new write does.
    const fixed = mergeLedger(grown, {
      writes: { seen: [], branched: ['POST /b'], unhandled: [] },
    });
    expect(regressions(fixed)).toEqual([]);
  });
});

describe('accepting a coverage drop', () => {
  // A level can fall for a reason nobody needs to cover: a control removed on purpose, a label
  // that carries a count. Without a way to say so, the ratchet stays red until someone deletes
  // .reticle/coverage.json by hand, which also throws away everything it measured.
  it('lowers the best to today, so the drop stops blocking, and keeps what was measured', () => {
    const covered = raiseBest(
      mergeLedger(emptyLedger(), {
        writes: { seen: ['POST /a'], branched: ['POST /a'], unhandled: [] },
      }),
    );
    const grown = mergeLedger(covered, {
      writes: { seen: ['POST /b'], branched: [], unhandled: [] },
    });
    expect(regressions(grown)).toHaveLength(1);
    const accepted = acceptCurrent(grown);
    expect(regressions(accepted)).toEqual([]);
    expect(accepted.writes).toEqual(grown.writes);
  });

  it('still blocks a drop that happens after the one it accepted', () => {
    const accepted = acceptCurrent(
      mergeLedger(emptyLedger(), {
        writes: { seen: ['POST /a', 'POST /b'], branched: ['POST /a'], unhandled: [] },
      }),
    );
    const worse = mergeLedger(accepted, {
      writes: { seen: ['POST /c'], branched: [], unhandled: [] },
    });
    expect(regressions(worse)).toHaveLength(1);
  });
});

describe('unexecutedChanged', () => {
  const code = {
    'src/Cart.tsx': { 'a@1': { name: 'a', executed: true } },
    'src/Refund.tsx': { 'r@1': { name: 'r', executed: false } },
  };
  it('names changed files the browser loaded and never ran a function of', () => {
    expect(
      unexecutedChanged(code, ['apps/web/src/Refund.tsx', 'src/Cart.tsx', 'src/Other.tsx']),
    ).toEqual(['apps/web/src/Refund.tsx']);
  });
});

/*
 * Two sessions fold into the same ledger at once. Each loaded the same copy and wrote its own
 * update, so the later write threw the other's coverage away.
 */
describe('LedgerStore — concurrent folds', () => {
  it('keeps both sessions’ coverage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reticle-ledger-'));
    const store = (): LedgerStore => new LedgerStore(createNodeFileSystem(), root);
    await Promise.all([
      store().merge({ routes: { reached: ['/a'] } }),
      store().merge({ routes: { reached: ['/b'] } }),
      store().merge({ routes: { reached: ['/c'] } }),
    ]);
    expect((await store().load()).routes.reached.sort()).toEqual(['/a', '/b', '/c']);
    await rm(root, { recursive: true, force: true });
  });
});

/*
 * Function counts are kept per file across takes, so an edited file keeps the counts of the version
 * before the edit. The gate read those as current and could judge a change that never ran. A file
 * modified after its last take is named as not measured since the change.
 */
describe('staleChanged — coverage taken before the file last changed', () => {
  const ledger = mergeLedger(emptyLedger(), {
    code: { 'src/Cart.tsx': { 'pay@10': { name: 'pay', executed: true } } },
    codeTakenAt: 1_000,
  });

  it('names a changed file whose last take predates the edit', () => {
    expect(staleChanged(ledger, ['web/src/Cart.tsx'], () => 2_000)).toEqual(['web/src/Cart.tsx']);
  });

  it('trusts a take made after the edit', () => {
    expect(staleChanged(ledger, ['web/src/Cart.tsx'], () => 500)).toEqual([]);
  });

  it('says nothing of a file coverage never saw, or one that no longer exists', () => {
    expect(staleChanged(ledger, ['src/Other.tsx'], () => 2_000)).toEqual([]);
    expect(staleChanged(ledger, ['src/Cart.tsx'], () => undefined)).toEqual([]);
  });

  it('treats a take with no recorded time as stale', () => {
    const old = mergeLedger(emptyLedger(), {
      code: { 'src/Cart.tsx': { 'pay@10': { name: 'pay', executed: true } } },
    });
    expect(staleChanged(old, ['src/Cart.tsx'], () => 1)).toEqual(['src/Cart.tsx']);
  });
});
