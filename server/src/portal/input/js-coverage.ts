import type { Page } from 'playwright';

/**
 * V8 JS coverage on a page Reticle drives — the raw half of "what of the app ever ran".
 *
 * Started once per page with `resetOnNavigation: false`, so a reload keeps counting instead of
 * starting over. A take stops and immediately restarts: the counts it returns are since the last
 * take, and the reader folds them as a union (see features/exhaust/code-coverage.ts).
 *
 * Chromium only. Anything else — or a page that closed — answers false/undefined rather than
 * throwing: coverage is an addition to a drive, never a reason for one to fail.
 */

/** One script's coverage — the shape `stopJSCoverage` returns, narrowed to what is read. */
export interface ScriptCoverage {
  url: string;
  functions: {
    functionName: string;
    ranges: { startOffset: number; endOffset: number; count: number }[];
  }[];
}

export async function startJsCoverage(page: Page, covering: WeakSet<Page>): Promise<boolean> {
  if (covering.has(page)) return true;
  try {
    await page.coverage.startJSCoverage({ resetOnNavigation: false });
    covering.add(page);
    return true;
  } catch {
    return false;
  }
}

export async function takeJsCoverage(
  page: Page,
  covering: WeakSet<Page>,
): Promise<ScriptCoverage[] | undefined> {
  // Nothing collects until something asks: collection slows every script on the page. The first
  // take starts it and has nothing to report yet.
  if (!covering.has(page)) {
    await startJsCoverage(page, covering);
    return undefined;
  }
  try {
    const entries = await page.coverage.stopJSCoverage();
    covering.delete(page);
    await startJsCoverage(page, covering);
    return entries;
  } catch {
    covering.delete(page);
    return undefined;
  }
}
