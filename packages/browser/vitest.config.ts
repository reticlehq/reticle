import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
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
     */
    testTimeout: 30_000,
  },
});
