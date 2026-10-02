/**
 * What counts as a test file. One list, because three scanners were each answering it differently.
 *
 * ── THE INCIDENT ────────────────────────────────────────────────────────────────────────────────
 * `server/dist/portal/bridge/bridge.test-harness.js` shipped to npm — 12K of test scaffolding
 * inside a published package. `prepare-dist.mjs` prunes on a literal `.test.`, and
 * `bridge.test-harness` has no dot after `test`. `orphan-scan.mjs` already knew the name
 * (`.test-harness.ts` was in its own list), and `directory-reach.mjs` used a third rule again — so
 * the same file was scaffolding to one scanner, an orphan candidate to another, and production code
 * to the third.
 *
 * That last one had a cost beyond the tarball: six of `bridge`'s recorded reaches — `flows`, `fs`,
 * `project`, `stores`, `tape`, `tools` — were the HARNESS's imports, counted against the bridge.
 * The coupling map said the bridge was twice as tangled as it is.
 *
 * Renaming the file would have fixed one scanner and broken the other two, which is how it was
 * discovered. The list lives here instead, and they all read it.
 */

/**
 * Suffixes that mean "test scaffolding, not a production module".
 *
 * Deliberately a suffix list rather than a pattern like `/test/`: `auto-testids.ts`,
 * `testid-near-miss.ts`, `network-mock.ts`, `storage-fixture.ts` and `test-context.ts` are all
 * product code that ships on purpose, and a looser rule deletes them from the tarball.
 */
export const TEST_SUFFIXES = [
  '.test.ts',
  '.test.tsx',
  '.test.mts',
  '.test.mjs',
  '.test-harness.ts',
  '.test-helpers.ts',
  '.live.test.ts',
];

/** True when this path is test scaffolding. Takes a path or a bare file name. */
export function isTestFile(path) {
  const name = String(path).split(/[\\/]/).pop() ?? '';
  return TEST_SUFFIXES.some((suffix) => name.endsWith(suffix));
}
