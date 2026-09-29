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
     * The jsdom window has to be the REAL one, because this package now constructs events with it.
     *
     * Synthetic input carries `view: el.ownerDocument.defaultView` so a handler can reach the window
     * the event happened in. The default `threads` pool copies jsdom's globals onto the Node global
     * and then rewrites `document.defaultView` to point at that Node global — which is not a
     * `Window`, so jsdom's own `UIEvent` constructor rejects it: "member view is not of type
     * Window". Measured on this package: 95 tests across 16 files, every one of them a click, drag,
     * hover, tap or check, fail under `threads` and pass here. The VM pool runs the test file inside
     * jsdom's context, so `globalThis === window === document.defaultView` the way a page has it.
     *
     * The alternatives were worse. Not passing `view` is the bug (#995). Passing it only when it
     * happens to be a `Window` would make the test environment decide what ships, and would swallow
     * the exact error a real browser would raise. Re-pointing `document.defaultView` from a setup
     * file patches the runner's own repair in the dark, and leaves `window` still meaning the Node
     * global, so an assertion could not name what it expected.
     *
     * What the pool costs: jsdom's globals no longer have Node's standing in behind them. Node's
     * `performance` has a Performance Timeline and jsdom's has only `now`/`toJSON`/`timeOrigin`, so
     * a test that wants `getEntriesByType` installs it — see `observers/navigation.test.ts`.
     */
    pool: 'vmThreads',
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
