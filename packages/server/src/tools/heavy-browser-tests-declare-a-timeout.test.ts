import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A test that builds thousands of DOM nodes must declare its own timeout.
 *
 * Vitest's default is 5 000 ms, and a default timeout is the same statement CLAUDE.md already
 * forbids in assertions — "a statement about the machine … fails only under parallel load, i.e.
 * only in CI". Observed on a Windows runner:
 *
 *   × stays bounded while a list renders and discards thousands of rows  7410ms
 *     → Test timed out in 5000ms.
 *
 * The assertion had not failed. The bound held. The runner was slow, and 5 000 rows of
 * `attachShadow` took longer than a number nobody chose for this test.
 *
 * `refs.test.ts` is the same shape — two tests at 20 000 iterations — and it flaked three separate
 * times tonight under full-monorepo load. I first guessed that one was GC-dependent; it is not, and
 * this is what it actually was.
 *
 * A generous timeout cannot make a broken test pass: the bound is still asserted, and a registry
 * that grew without limit would still fail. It only stops the suite reporting the runner.
 *
 * Coarse by design, in two ways worth stating rather than discovering later:
 *
 *  1. It checks that a file with a heavy loop declares SOME explicit timeout, not that the right
 *     `it()` carries it. A precise version would need to parse the file, and the failure this
 *     guards against is someone deleting the timeout wholesale, not moving it.
 *  2. The loop pattern only sees a literal or `CONST * n` bound. `refs.test.ts` hides its heaviest
 *     loop behind a `fill(n)` helper — ~20 000 elements APPENDED to the document — and this rule
 *     would not have found it. I found it by reading, and gave it a timeout too. A guard that
 *     cannot see indirection should say so instead of implying coverage it does not have.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..', '..');
/**
 * Scanned from the SERVER package, not the browser one, because `@reticlehq/browser` may not import
 * Node builtins — it runs in the DOM, and the lint rule that says so is a real architectural
 * boundary rather than a nuisance. Every other source-scanning guard in this repo lives here for
 * the same reason (see e2e-surface-drift.test.ts).
 */
const SRC = join(REPO, 'packages', 'browser', 'src');

/** A loop big enough that the default timeout is a coin flip on a loaded runner. */
const HEAVY_LOOP = /for \([^)]*<\s*(?:\d{4,}|[A-Z_]+ \* \d)/;
/**
 * `}, 60_000);` or `}, HEAVY_DOM_TIMEOUT_MS);` — an explicit per-test timeout.
 *
 * A NAMED constant counts, and must: this repo's convention is that a magic number gets a name, so a
 * rule that only accepted a literal would push the fix toward worse style. My first version did
 * exactly that and failed against its own remedy.
 *
 * Whitespace-tolerant because prettier splits the call once it grows:
 *
 *     },
 *     HEAVY_DOM_TIMEOUT_MS,
 *   );
 *
 * A single-line pattern matched neither of the two files it was written for. A guard has to match
 * what the formatter actually emits, not what the author typed.
 */
const EXPLICIT_TIMEOUT = /\},\s*(?:\d[\d_]{3,}|[A-Z][A-Z0-9_]*_MS)\s*,?\s*\)/;

function testFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...testFiles(full));
    else if (entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

describe('heavy DOM tests do not rely on the default timeout', () => {
  const heavy = testFiles(SRC)
    .map((file) => ({ file, text: readFileSync(file, 'utf8') }))
    .filter(({ text }) => HEAVY_LOOP.test(text));

  it('finds the heavy files at all — a vacuous rule is not a rule', () => {
    // Guards the guard: if the pattern stops matching, everything below passes for free.
    expect(heavy.length).toBeGreaterThan(0);
  });

  it('every file that builds thousands of nodes declares an explicit timeout', () => {
    const missing = heavy
      .filter(({ text }) => !EXPLICIT_TIMEOUT.test(text))
      .map(({ file }) => relative(SRC, file));
    expect(missing).toEqual([]);
  });
});
