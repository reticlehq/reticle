/**
 * Test timeouts, in one place, for every package in this repository.
 *
 * ## The defect this fixes
 *
 * `pnpm verify` ran 27 tasks in parallel against vitest's 5s per-test default. Suites that do real
 * work — spawning node, transforming with babel, walking the tree — take far longer than that while
 * the box is saturated, and the file totals say so plainly:
 *
 *     cjs-loadable.test.ts               5 tests | 1 failed   43521ms
 *     directory-reach-detects-a-pair     5 tests | 5 failed   34365ms
 *     bench-scenarios-live.test.ts       7 tests | 2 failed   19031ms
 *
 * Every one of those failures was `Test timed out in 5000ms`, and every one of those files passes
 * alone in seconds. Ten such failures were seen in a single session across `next`, `babel-plugin`,
 * `react`, `vite-plugin` and `server`, each time in whichever package happened to lose the race.
 *
 * ## Why it mattered more than the noise
 *
 * `test:unit` is `turbo run test:unit test:guards && pnpm test:bench`. A timeout anywhere in the
 * turbo step short-circuits the `&&`, so `test:bench` NEVER RUNS — and that is where the bench
 * injector's anchor guard lives. A real regression (`missing-modal`'s anchor drifting, which would
 * have scored seven planted bugs against a denominator of eight) sat behind a flake and reached
 * `main` with three green-looking local runs in front of it. A flaky gate does not merely annoy;
 * it hides whatever is queued behind it.
 *
 * ## Why a timeout and not an assertion
 *
 * CLAUDE.md: "If the property is 'cost is fixed', assert the bound (output size, truncation flag) or
 * use a generous per-test timeout — never `Date.now() - t < N`, which is a statement about the
 * machine and fails only under parallel load." A 5s cap on a suite that legitimately takes 40s under
 * load is that same mistake in a different place: it asserts about the machine, not the product.
 *
 * The cost of a generous bound is that a genuinely hung test takes this long to report instead of
 * five seconds. That is the right trade: a hang is rare and obvious, and a false red is neither.
 */

/**
 * Per-test bound, and the number is measured rather than picked.
 *
 * Run ALONE on an idle machine, `safe-to-group-answers-everywhere` takes 26s and
 * `mock-specifiers-resolve` 15s — they walk the whole repository per test. A 30s bound was tried
 * first and still failed under the gate: a test that costs 26s with the box to itself has no
 * headroom left when anything else is running. 60s gives the slowest of them a little over 2x.
 */
export const TEST_TIMEOUT_MS = 60_000;

/** `beforeAll`/`afterAll` do the same kind of work (temp dirs, builds) and lose the same race. */
export const HOOK_TIMEOUT_MS = 60_000;

/**
 * How many worker processes ONE package may use.
 *
 * The bound alone was not enough, and the reason is arithmetic. `turbo` runs the packages in
 * parallel and each `vitest` then forks a worker per core, so on an 8-core box the gate was asking
 * for something like twenty-seven times eight processes at once. Raising the per-test bound to 30s
 * left four guards still timing out; they are I/O bound — each walks the whole repository — and on
 * Windows that contention is what actually costs the time, not CPU.
 *
 * So the fix has two halves and this is the one that matters: cap the workers so the machine is not
 * oversubscribed, and keep the generous bound for the work that is genuinely slow. `--concurrency`
 * on the turbo run caps the other side.
 */
export const MAX_WORKERS = 3;

/** Spread into a package's `test` block so no package is left on the 5s default. */
export const sharedTestOptions = {
  testTimeout: TEST_TIMEOUT_MS,
  hookTimeout: HOOK_TIMEOUT_MS,
  maxWorkers: MAX_WORKERS,
} as const;
