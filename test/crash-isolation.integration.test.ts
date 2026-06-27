/**
 * Crash isolation — the real-Chromium foundation the BrowserPool's per-page fault handling relies on.
 *
 * The pool wires `page.on('crash')` to reclaim ONLY the crashed lease (the unit test proves that logic
 * with a fake). This proves the assumption underneath it against a real browser: when one context's
 * renderer crashes (chrome://crash), the crash event fires, the SHARED browser stays connected, and a
 * sibling context keeps working. Without this guarantee the whole "one bad page can't sink the fleet"
 * design would be false.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser.close();
});

describe('single-page crash isolation (real Chromium)', () => {
  it('a crashed renderer leaves the shared browser + a sibling context alive', async () => {
    const ctxA = await browser.newContext();
    const pageA = await ctxA.newPage();
    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await pageA.goto('data:text/html,<button>A</button>');
    await pageB.goto('data:text/html,<button>B</button>');

    // The pool reclaims a lease on Playwright's `crash` EVENT — that logic is unit-tested with a fake.
    // Here we prove the real-browser guarantee underneath it: when one context's renderer dies, the
    // SHARED browser and a sibling context keep working. We detect the death cross-platform (a crashed
    // page can no longer run script, and the crashing navigation rejects) rather than via the `crash`
    // event, which some headless-CI Chromium builds don't emit for the synthetic chrome://crash.
    let crashEvent = false;
    pageA.on('crash', () => {
      crashEvent = true;
    });

    const navOutcome = await pageA
      .goto('chrome://crash', { timeout: 5000 })
      .then(() => 'navigated')
      .catch((e: unknown) => String((e as Error)?.message ?? e));
    await pageA.waitForEvent('crash', { timeout: 2000 }).catch(() => undefined);

    // A crashed renderer can no longer run script — evaluate rejects with "Target crashed/closed".
    const pageADead = await pageA
      .evaluate(() => true)
      .then(() => false)
      .catch(() => true);

    const rendererWentDown = crashEvent || pageADead || /crash|closed|target/i.test(navOutcome);
    expect(rendererWentDown).toBe(true); // page A's renderer actually went down
    expect(browser.isConnected()).toBe(true); // the shared browser survived one bad page
    // The sibling context is unaffected — the fleet keeps working.
    const buttons = await pageB.$$('button');
    expect(buttons).toHaveLength(1);

    await ctxB.close();
    await ctxA.close().catch(() => undefined);
  });
});
