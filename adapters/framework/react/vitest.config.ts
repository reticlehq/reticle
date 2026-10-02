import { defineConfig } from 'vitest/config';
import { sharedTestOptions } from '../../../vitest.shared.js';
import tsconfigPaths from 'vite-tsconfig-paths';
import { fileURLToPath } from 'node:url';

/*
 * `@/x` -> the src of whichever PACKAGE the importing file belongs to.
 *
 * Resolved by reading the nearest tsconfig, not by a static alias, and the difference is
 * load-bearing here. A static `@/` -> `./src` says "this package" for every file in the run, and
 * this repo deliberately loads OTHER packages from source — `@reticlehq/core` is aliased to core's
 * src so a stale build cannot turn a test into a tautology. Core's files then say `@/wire/...` and
 * mean CORE's src, inside a run whose own package is a different one. Only a per-file resolver can
 * answer both correctly, which is exactly what tsconfig does for the compiler.
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: 'jsdom',
    /**
     * For the same reason as `@reticlehq/browser`, whose reasoning is written out in full there.
     *
     * `drag-select.test.ts` and `actions-controlled.test.ts` drive the browser SDK's synthetic
     * input against a React tree. That input now carries `view: el.ownerDocument.defaultView`, and
     * under the default `threads` pool that property has been rewritten to the Node global, which
     * jsdom's `UIEvent` constructor rejects — 5 tests in those two files fail there and pass here.
     * This package asks nothing of Node's globals, so the switch costs it nothing.
     */
    pool: 'vmThreads',
    // Every package shares one bound; see vitest.shared.ts for the gate this kept red.
    ...sharedTestOptions,
  },
});
