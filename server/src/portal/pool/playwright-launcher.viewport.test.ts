/**
 * The pooled launcher gives each lease context a real page size.
 *
 * Without one, Playwright gave every lease a fixed 1280x720 at pixel ratio 1. A headed lease then
 * rendered small and soft on a Retina screen, and a bigger window changed nothing. Playwright is
 * mocked, so this proves the options without a Chromium.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ColorScheme } from './lease-emulation.js';

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

describe('playwrightLauncher and the page size', () => {
  beforeEach(() => {
    contextOptions.length = 0;
  });

  it('gives a headless lease the explicit default size', async () => {
    const browser = await playwrightLauncher({ headless: true })();
    await browser.newContext();
    expect(contextOptions).toEqual([{ viewport: { width: 1440, height: 900 } }]);
  });

  it('gives a headed lease no viewport, so it takes the window size', async () => {
    const browser = await playwrightLauncher({ headless: false })();
    await browser.newContext();
    expect(contextOptions).toEqual([{ viewport: null }]);
  });

  it('keeps the size and the media that a lease asks for', async () => {
    const asked = { width: 375, height: 812 };
    for (const headless of [true, false]) {
      const browser = await playwrightLauncher({ headless })();
      await browser.newContext({ viewport: asked, colorScheme: ColorScheme.DARK });
    }
    const expected = { viewport: asked, colorScheme: ColorScheme.DARK };
    expect(contextOptions).toEqual([expected, expected]);
  });
});
