import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { reachableFrom } from './import-graph.js';

/**
 * The walker's keys are one spelling, whatever the caller hands it.
 *
 * Found on Windows CI, 2026-09-13. `resolveImport` normalises every path the walker DISCOVERS to
 * `/`, but `reachableFrom` seeded its map with the caller's `entry` verbatim — and both callers
 * build that entry with `join()`, which yields `features\license\license.ts` on Windows. So the
 * seed was the single key in the map with the other separator, and a caller filtering with
 * `startsWith('features/license/')` silently dropped exactly the module it had asked about.
 *
 * What that cost: a boundary guard whose two real assertions both expected an EMPTY list, so a
 * walker that finds nothing AGREED with them. The boundary was unchecked on Windows for as long as
 * it existed, and passing. Its negative control was the only thing that could see it, which is the
 * entire argument for writing negative controls.
 *
 * Asserted here rather than there because the defect is the walker's, and both of its callers
 * inherit the fix.
 */
const SRC = __dirname;

describe('reachableFrom', () => {
  const ENTRY = join('features', 'license', 'license.ts');

  it('answers in one path spelling however the caller spelled the entry', () => {
    const posix = [...reachableFrom(SRC, 'features/license/license.ts').keys()];
    const native = [...reachableFrom(SRC, ENTRY).keys()];
    expect(native).toEqual(posix);
  });

  it('finds the entry under a prefix written with forward slashes — the Windows case', () => {
    // The negative control a boundary guard makes, restated against the walker and with the entry
    // built the way a caller really builds it. It returned 0 on Windows.
    const underDirectory = [...reachableFrom(SRC, ENTRY).keys()].filter((file) =>
      file.startsWith('features/license/'),
    );
    expect(underDirectory.length).toBeGreaterThan(0);
  });

  it('normalises a backslash entry even where the platform separator is /', () => {
    // The two above cannot fail on a POSIX machine, because `join` already yields `/` there — so
    // they would have passed on every developer's laptop while the bug shipped. This one states the
    // rule directly and is red on ANY platform if the seed stops being normalised.
    const keys = [...reachableFrom(SRC, 'features\\license\\license.ts').keys()];
    expect(keys).toContain('features/license/license.ts');
  });
});
