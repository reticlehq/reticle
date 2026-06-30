import { defineConfig } from 'vitest/config';

/**
 * Integration suite (root `test/`) — heavy, real-Chromium tests kept OUT of the fast per-package unit
 * gate. Run with `pnpm test:integration` (build the workspace first; the tests import the built
 * @reticle/server). Browsers are resource-heavy, so files run serially.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.integration.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    // Free the suite's fixed ports up-front so a dev server/bridge leaked by a previously interrupted
    // run can't contaminate this one. Runs in the main process, where spawning is safe.
    globalSetup: ['./test/global-setup.ts'],
  },
});
