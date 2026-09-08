/**
 * The shipped bundle must parse under an ES2019 parser.
 *
 * `react-scripts` 4 / webpack 4 excludes `node_modules` from Babel, so it reads our `dist` as-is
 * with acorn. Optional chaining, nullish coalescing (both ES2020) and logical assignment (ES2021)
 * are all parse errors there — the app fails to compile at `dist/index.js` before a dev session
 * could ever connect, with no diagnostic, because it simply does not build.
 *
 * `init` already prints a recipe when it detects `react-scripts@<5`. That was the weaker of the two
 * fixes the report offered, and the report's argument for the other one stands: "an install path
 * that requires the user to edit their bundler config to run our dev-only SDK is an install path
 * most people abandon."
 *
 * PARSED, not grepped, and that is the whole design. The first version of this test matched
 * operators with regexes and produced two false failures on `dist` that was already correct — the
 * hits were inside COMMENTS, one of them a comment quoting the very `form?.textContent` the fix had
 * removed. A regex cannot tell code from prose about code. acorn is the same parser webpack 4 uses,
 * so this fails exactly where a user's build would, and nowhere else.
 *
 * Asserted against the BUILT artifact: the source may use whatever it likes, and what matters is
 * what `tsc` emits under this package's deliberately-lowered `target`.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');

/** The ES version react-scripts 4's webpack can parse. */
const WEBPACK4_ECMA_VERSION = 2019;

/**
 * EVERY emitted module, not just the entry. `dist/index.js` is a small barrel of re-exports and the
 * code a consumer's bundler chokes on lives in what it imports — the defect was in 52 siblings while
 * the entry was clean. Compiled tests are skipped: they are not reachable from the entry.
 */
function emittedModules(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...emittedModules(full));
    else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) out.push(full);
  }
  return out;
}

describe('the published browser bundle parses on webpack 4', () => {
  it('has modules to check at all', () => {
    // Guards the guard: an empty or unbuilt dist would make the assertion below vacuously true.
    // A loose floor on purpose — pinning today's count would fail on any refactor that merges files,
    // which is a different thing from the build being absent.
    expect(emittedModules(DIST).length).toBeGreaterThan(50);
  });

  it('would REJECT the syntax it is checking for — the negative control', () => {
    // A parser check that cannot fail proves nothing. These are the three operators from the report;
    // if acorn's ecmaVersion ever stops rejecting them, the assertion above goes quietly vacuous.
    for (const source of ['a?.b;', 'a ?? b;', 'a ??= b;']) {
      expect(() =>
        parse(source, { ecmaVersion: WEBPACK4_ECMA_VERSION, sourceType: 'module' }),
      ).toThrow();
    }
  });

  it('parses every emitted module at ES2019', () => {
    const failures: string[] = [];
    for (const file of emittedModules(DIST)) {
      try {
        parse(readFileSync(file, 'utf8'), {
          ecmaVersion: WEBPACK4_ECMA_VERSION,
          sourceType: 'module',
        });
      } catch (error) {
        failures.push(`${file.slice(DIST.length + 1)}: ${(error as Error).message}`);
      }
    }
    expect(failures).toEqual([]);
  });
});
