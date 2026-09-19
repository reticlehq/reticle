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
  // Every package shares one bound; see vitest.shared.ts for the gate this kept red.
  test: {
    environment: 'jsdom',
    environmentOptions: {
      jsdom: {
        url: 'http://localhost/',
      },
    },
    setupFiles: ['./vitest.setup.ts'],
    /**
     * jsdom is slow, and this package's heaviest tests mount an entire HUD into it. Under a loaded
     * runner — CI, or a machine running several suites at once — that exceeds vitest's 5s default,
     * and the suite fails for a reason that has nothing to do with the code. It has now been
     * observed across several different presenter files rather than one, so it is a property of the
     * environment and belongs in the environment's configuration.
     *
     * This is a BOUND, not a duration. Nothing here asserts how long anything took — the repo
     * forbids that outright — so raising the ceiling cannot mask a regression: a broken expectation
     * still fails immediately, and a genuine hang still fails, just with headroom for a busy
     * machine. A test that sets its own timeout keeps it; the value below only applies where none
     * was chosen deliberately.
     *
     * The NUMBER moved to `vitest.shared.ts` once every other package needed the same thing for the
     * same reason. The reasoning above is why this package hit it first — jsdom plus a whole HUD —
     * and it is still the clearest statement of it, so it stays here rather than being deleted into
     * a shared file nobody reads on the way past.
     */
    ...sharedTestOptions,
  },
});
