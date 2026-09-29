import { describe, expect, it } from 'vitest';
import {
  emptyLedger,
  levelsOf,
  mergeLedger,
  raiseBest,
  regressions,
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
