import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { reachableFrom } from './import-graph.js';

/**
 * The walker's keys are one spelling, whatever the caller hands it.
 *
 * Found on Windows CI, 2026-09-13. `resolveImport` normalises every path the walker DISCOVERS to
 * `/`, but `reachableFrom` seeded its map with the caller's `entry` verbatim — and both callers
 * build that entry with `join()`, which yields `features\ee\audit-log.ts` on Windows. So the seed
 * was the single key in the map with the other separator, and a caller filtering with
 * `startsWith('features/ee/')` silently dropped exactly the module it had asked about.
 *
 * What that cost: `ee-boundary` — the guard that says the free build cannot reach the
 * separately-licensed code — has two real assertions and both expect an EMPTY list, so a walker
 * that finds nothing AGREES with them. The licence boundary was unchecked on Windows for as long
 * as it has existed, and passing. Its negative control was the only thing that could see it, which
 * is the entire argument for writing negative controls.
 *
 * Asserted here rather than there because the defect is the walker's, and both of its callers
 * inherit the fix.
 */
const SRC = __dirname;

describe('reachableFrom', () => {
  const ENTRY = join('features', 'ee', 'audit-log.ts');

  it('answers in one path spelling however the caller spelled the entry', () => {
    const posix = [...reachableFrom(SRC, 'features/ee/audit-log.ts').keys()];
    const native = [...reachableFrom(SRC, ENTRY).keys()];
    expect(native).toEqual(posix);
  });

  it('finds the entry under a prefix written with forward slashes — the Windows case', () => {
    // This is the assertion ee-boundary's negative control makes, restated against the walker and
    // with the entry built the way a caller really builds it. It returned 0 on Windows.
    const underPaidDirectory = [...reachableFrom(SRC, ENTRY).keys()].filter((file) =>
      file.startsWith('features/ee/'),
    );
    expect(underPaidDirectory.length).toBeGreaterThan(0);
  });

  it('normalises a backslash entry even where the platform separator is /', () => {
    // The two above cannot fail on a POSIX machine, because `join` already yields `/` there — so
    // they would have passed on every developer's laptop while the bug shipped. This one states the
    // rule directly and is red on ANY platform if the seed stops being normalised.
    const keys = [...reachableFrom(SRC, 'features\\ee\\audit-log.ts').keys()];
    expect(keys).toContain('features/ee/audit-log.ts');
  });
});
