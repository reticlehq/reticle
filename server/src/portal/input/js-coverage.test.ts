import { describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { takeJsCoverage } from './js-coverage.js';

/** A page whose coverage calls are counted, standing in for Playwright's. */
function fakePage(): { page: Page; starts: () => number; stops: () => number } {
  let starts = 0;
  let stops = 0;
  const coverage = {
    startJSCoverage: (): Promise<void> => {
      starts += 1;
      return Promise.resolve();
    },
    stopJSCoverage: (): Promise<[]> => {
      stops += 1;
      return Promise.resolve([]);
    },
  };
  return { page: { coverage } as unknown as Page, starts: () => starts, stops: () => stops };
}

/**
 * Collecting V8 coverage slows every script on the page, and a page that runs slower can let a
 * console error land after a replay's clean-console check has already passed. The console-clean
 * benchmark measured exactly that: a replay that fails on main passed once collection was on for
 * every driven page. So nothing collects until something asks for coverage.
 */
describe('code coverage is collected only once something asks for it', () => {
  it('starts collecting on the first take, and reports nothing measured yet', async () => {
    const { page, starts, stops } = fakePage();
    const covering = new WeakSet<Page>();
    expect(await takeJsCoverage(page, covering)).toBeUndefined();
    expect(starts()).toBe(1);
    expect(stops()).toBe(0);
  });

  it('returns what ran on a later take, and keeps collecting', async () => {
    const { page, starts, stops } = fakePage();
    const covering = new WeakSet<Page>();
    await takeJsCoverage(page, covering);
    expect(await takeJsCoverage(page, covering)).toEqual([]);
    expect(stops()).toBe(1);
    expect(starts()).toBe(2);
  });
});
