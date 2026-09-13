/**
 * Telling Vitest's browser-mode runner apart from every other Vite server.
 *
 * Split out of index.ts at the file cap. Small, but it is the discriminator a wrong first cut got
 * wrong in production, so it earns its own file and its own name.
 */

/**
 * Is THIS server Vitest's browser-mode runner?
 *
 * Vitest browser mode renders each component test into its own iframe served by the same Vite dev
 * server, so `transformIndexHtml` injects into every one of them. The HUD then sits in the test
 * document's hit-test path and intercepts pointer events, and a user who adds Reticle watches their
 * unrelated component tests start timing out on clicks.
 *
 * The signal is `test.browser.enabled` on the RESOLVED config. The first cut used the `VITEST`
 * environment variable and was wrong in a way its own unit tests could not show: `VITEST` means
 * "Vitest is running somewhere in this process", which is ALSO true when a Vitest suite boots an app
 * in order to test it. `frameworks.integration.test.ts` starts a real Vite dev server per example
 * app and asserts Reticle connects; under the env check it injected nothing and the suite failed
 * with "@reticlehq/example-react never connected an Reticle session". CI caught that; three local
 * battery runs did not, because that suite is not the battery.
 *
 * A bare `test` key is wrong the other way — most projects configure Vitest and are not under it.
 * `test.browser.enabled` is true only for the server actually serving browser-mode test iframes,
 * which is the one case with a HUD to suppress.
 *
 * An explicit `inject: true` still beats it: the check is a default chosen on the user's behalf.
 */
export function isVitestBrowserServer(config: { test?: unknown }): boolean {
  const test = config.test;
  if (null === test || 'object' !== typeof test) return false;
  const browser = (test as { browser?: unknown }).browser;
  if (null === browser || 'object' !== typeof browser) return false;
  return true === (browser as { enabled?: unknown }).enabled;
}
