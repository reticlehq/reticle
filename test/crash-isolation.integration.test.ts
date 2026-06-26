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
  it('a crashed renderer fires crash, leaves the browser + a sibling context alive', async () => {
    const ctxA = await browser.newContext();
    const pageA = await ctxA.newPage();
    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await pageA.goto('data:text/html,<button>A</button>');
    await pageB.goto('data:text/html,<button>B</button>');

    let crashed = false;
    pageA.on('crash', () => {
      crashed = true;
    });

    // Crash page A's renderer. The navigation rejects when the page goes down — expected.
    await pageA.goto('chrome://crash', { timeout: 3000 }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 500));

    expect(crashed).toBe(true); // the pool's reclaim trigger actually fires
    expect(browser.isConnected()).toBe(true); // the shared browser survived one bad page
    // The sibling context is unaffected — the fleet keeps working.
    const buttons = await pageB.$$('button');
    expect(buttons).toHaveLength(1);

    await ctxB.close();
    await ctxA.close().catch(() => undefined);
  });
});
