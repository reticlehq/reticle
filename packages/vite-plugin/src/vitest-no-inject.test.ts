/**
 * The HUD must not be injected into a Vitest browser-mode test iframe.
 *
 * Vitest browser mode renders each component test into its own iframe served by the SAME Vite dev
 * server, so `transformIndexHtml` injects into every one of them. The HUD lands in the test document
 * where it has no purpose, sits in the hit-test path, and intercepts pointer events — so a user adds
 * Reticle and their unrelated component tests start timing out on clicks.
 *
 * Reticle breaking the test suite it is sitting inside is the worst possible first impression, and
 * it is not even a trade: there is nothing for Reticle to observe in a component-test iframe.
 *
 * The signal is `test.browser.enabled` on the resolved config — this server IS the browser-mode
 * runner. NOT the `VITEST` env var, which was the first cut and was wrong: it means "Vitest is
 * running somewhere in this process", which is also true when a Vitest suite BOOTS AN APP to test
 * it. `frameworks.integration.test.ts` does exactly that, and the env check made every example app
 * connect nothing — caught by CI, missed by three local battery runs, because that suite is not the
 * battery.
 *
 * A bare `test` key would be wrong the other way: most projects have one and are not under test.
 */

import { describe, expect, it } from 'vitest';
import { reticle } from './index.js';

/** Drive the plugin the way Vite does: resolve a config, then ask for the HTML tags. */
const tagsFor = (config: Record<string, unknown>): unknown[] => {
  const plugin = reticle();
  plugin.configResolved?.(config);
  return plugin.transformIndexHtml('<html></html>');
};

const BROWSER_MODE = { test: { browser: { enabled: true } } };

describe('the plugin stays out of a Vitest BROWSER-MODE server', () => {
  it('injects nothing into a browser-mode test server', () => {
    expect(tagsFor(BROWSER_MODE)).toEqual([]);
  });

  it('still injects in an ordinary dev server', () => {
    expect(tagsFor({}).length, 'the normal path must be untouched').toBeGreaterThan(0);
  });

  it('still injects for a Vitest suite that BOOTS AN APP', () => {
    // The regression this replaced. `frameworks.integration.test.ts` runs under Vitest and starts a
    // real Vite server per example app; that server's config has no `test.browser`, and the app must
    // be instrumented or the suite is asserting against a page with no SDK in it.
    expect(tagsFor({}).length).toBeGreaterThan(0);
  });

  it('still injects when the project merely HAS a test block', () => {
    // Most projects configure Vitest. Having it is not being it.
    expect(tagsFor({ test: { globals: true } }).length).toBeGreaterThan(0);
    expect(tagsFor({ test: { browser: { enabled: false } } }).length).toBeGreaterThan(0);
  });

  it('honours an explicit inject: true even in browser mode', () => {
    // The check is a default chosen on the user's behalf; somebody who wrote the option down means it.
    const plugin = reticle({ inject: true });
    plugin.configResolved?.(BROWSER_MODE);
    expect(plugin.transformIndexHtml('<html></html>').length).toBeGreaterThan(0);
  });
});
