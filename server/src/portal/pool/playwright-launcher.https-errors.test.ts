/**
 * The last step of #1255: the real launcher hands `ignoreHTTPSErrors` to Playwright's own
 * `browser.newContext`. The pool tests stop at a fake launcher, so a launcher that dropped the option
 * would leave them green while an opted-in lease still refused a local certificate. Playwright is
 * mocked, so this proves the forwarding without a Chromium.
 */
import { describe, expect, it, vi } from 'vitest';

const contextOptions: unknown[] = [];

vi.mock('playwright', () => ({
  chromium: {
    launch: vi.fn(() =>
      Promise.resolve({
        isConnected: () => true,
        newContext: vi.fn((opts?: unknown) => {
          contextOptions.push(opts);
          return Promise.resolve({ close: () => Promise.resolve() });
        }),
        close: () => Promise.resolve(),
        on: () => {},
      }),
    ),
  },
}));

import { playwrightLauncher } from './playwright-launcher.js';

describe('playwrightLauncher and certificates', () => {
  it('passes ignoreHTTPSErrors to Playwright only when a lease asked for it', async () => {
    const browser = await playwrightLauncher({ headless: true })();

    await browser.newContext();
    await browser.newContext({ ignoreHTTPSErrors: false });
    await browser.newContext({ ignoreHTTPSErrors: true });

    expect(contextOptions).toEqual([undefined, undefined, { ignoreHTTPSErrors: true }]);
  });
});
