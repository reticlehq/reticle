import { defineConfig } from 'vitest/config';

/**
 * Integration suite (root `test/`) — heavy, real-Chromium tests kept OUT of the fast per-package unit
 * gate. Run with `pnpm test:integration` (build the workspace first; the tests import the built
 * @reticlehq/server). Browsers are resource-heavy, so files run serially.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.integration.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    // Refuse occupied fixture ports and isolate daemon state; never kill another process.
    globalSetup: ['./test/global-setup.ts'],
  },
});
