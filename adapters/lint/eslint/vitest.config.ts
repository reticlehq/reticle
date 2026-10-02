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
    environment: 'node',
    // Every package shares one bound; see vitest.shared.ts for the gate this kept red.
    ...sharedTestOptions,
  },
});
