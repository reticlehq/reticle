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
/**
 * EVERY package's sources, not only the browser's.
 *
 * Scoped to `packages/browser/src` originally because that is where the incident happened. The
 * identical failure then arrived in `packages/server/src`: a test timed out at vitest's 5s default
 * on Windows CI and nowhere else, which reads as a product failure and is a statement about the
 * machine. Guarding one directory against a repo-wide failure mode is a mistake this repo has now
 * made three times in one day, in three different guards.
 *
 * Widening cost exactly one annotation, which is the argument for having done it at the start.
 */
const PACKAGES = join(REPO, 'packages');

/** A loop big enough that the default timeout is a coin flip on a loaded runner. */
const HEAVY_LOOP = /for \([^)]*<\s*(?:\d{4,}|[A-Z_]+ \* \d)/;
/**
 * The second shape: heavy because of what is INSIDE the loop, not because of the iteration count.
 *
 * `project-tools.test.ts` timed out at vitest's 5s default on Windows CI and nowhere else. It loops
 * **40 times**, writing run records sequentially through the real filesystem port. Milliseconds on
 * macOS and Linux, much slower on a Windows runner — and no count-based rule can see it, because 40
 * is not a big number. `HEAVY_LOOP` above was written for the browser incident and is blind to this
 * one by construction.
 *
 * Two conditions, ANDed, and the conjunction is the whole point. `await` in a loop is common and
 * usually cheap; a real temp directory is what turns each iteration into a syscall. Either half
 * alone is a blanket rule over most of the suite. Together, and with hook bodies excluded, they
 * matched 11 of 558 test files when this was written — which is why `EXPECTED_IO_LOOP_FILES` below
 * is pinned rather than left implicit.
 */
const REAL_TEMP_DIR = /\bmkdtemp(?:Sync)?\s*\(/;
const LOOP_HEAD = /\b(?:for|while)\s*\(/g;
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

/**
 * Does any `for`/`while` body in this source await?
 *
 * Brace-matched from the loop head rather than pattern-matched across the file. The regex form of
 * this — `/for \([^)]*\)[^]*?await/` — matches a loop with an unrelated `await` 200 lines below it,
 * which is most files in this repo and none of the shape being guarded against.
 *
 * Coarse in the same way the rest of this guard is, and worth stating rather than discovering: the
 * brace counting does not skip braces inside strings, template literals or comments, so a test file
 * containing `` `${a}` `` inside a loop could end the body early. That direction is a FALSE
 * NEGATIVE — the guard under-reports and stays silent — which is the safe way for it to be wrong.
 * A version that cannot be fooled needs a parser, and the failure mode here is a file drifting into
 * the shape unnoticed, not someone hiding one deliberately.
 */
function hasAwaitInsideLoop(text: string): boolean {
  const scanned = withoutHookBodies(text);
  LOOP_HEAD.lastIndex = 0;
  for (let head = LOOP_HEAD.exec(scanned); head !== null; head = LOOP_HEAD.exec(scanned)) {
    const body = loopBody(scanned, scanned.indexOf('(', head.index));
    if (body !== null && /\bawait\b/.test(body)) return true;
  }
  return false;
}

/**
 * `beforeEach`/`afterEach`/`beforeAll`/`afterAll` bodies, blanked out.
 *
 * A per-test timeout is the wrong remedy for a slow hook: vitest bounds hooks with `hookTimeout`,
 * which `}, TIMEOUT_MS)` on an `it()` does not touch. Flagging a file for a hook loop would demand an
 * annotation that cannot fix the thing being flagged.
 *
 * This is not hypothetical — it is the one false positive the shape produced on this checkout.
 * `mcp/proxy-reconnect-fanout.test.ts` matches on nothing but `for (const cleanup of
 * cleanups.splice(0).reverse()) await cleanup();` in its teardown. Excluding hooks drops it and
 * changes no other file, which is the argument for narrowing here rather than annotating around it.
 *
 * Blanked to spaces rather than deleted so every offset in the scanned copy still lines up with the
 * original — a deletion would silently join a loop head to a body that is not its own.
 */
function withoutHookBodies(text: string): string {
  const HOOK = /\b(?:before|after)(?:Each|All)\s*\(/g;
  let out = text;
  for (let hook = HOOK.exec(text); hook !== null; hook = HOOK.exec(text)) {
    const open = text.indexOf('(', hook.index);
    let depth = 0;
    for (let close = open; close < text.length; close += 1) {
      if ('(' === text[close]) depth += 1;
      else if (')' === text[close]) {
        depth -= 1;
        if (0 === depth) {
          out = out.slice(0, open) + ' '.repeat(close - open + 1) + out.slice(close + 1);
          break;
        }
      }
    }
  }
  return out;
}

/**
 * The loop's body, brace-matched — or, for a brace-less loop, its single statement.
 *
 * The brace-less case is not an edge case here, it is the majority: `for (const d of […]) await
 * store.record(…)` is how most of these tests are written. A first cut jumped to the next `{` after
 * the loop head, which for a brace-less loop is some unrelated block further down the file, and it
 * mis-reported two files on this checkout for exactly that reason. Skipping the loop's own
 * parentheses first also matters — `for (let i = 0; i < n; i += 1)` contains no braces but the
 * header can contain anything.
 */
function loopBody(text: string, headOpen: number): string | null {
  if (-1 === headOpen) return null;
  let parens = 0;
  let cursor = headOpen;
  for (; cursor < text.length; cursor += 1) {
    if ('(' === text[cursor]) parens += 1;
    else if (')' === text[cursor]) {
      parens -= 1;
      if (0 === parens) break;
    }
  }
  const start = text.slice(cursor + 1).search(/\S/);
  if (-1 === start) return null;
  const open = cursor + 1 + start;
  if (text[open] !== '{') {
    const end = text.indexOf(';', open);
    return -1 === end ? text.slice(open) : text.slice(open, end);
  }
  let depth = 0;
  for (let close = open; close < text.length; close += 1) {
    if ('{' === text[close]) depth += 1;
    else if ('}' === text[close]) {
      depth -= 1;
      if (0 === depth) return text.slice(open, close);
    }
  }
  return text.slice(open);
}

/**
 * Pinned so the rule cannot silently widen into "every loop in the repo".
 *
 * 12 of 558 `.test.ts` files, or 2%. The count is the guard's own blast radius: if a later edit drops
 * the `mkdtemp` half or the hook exclusion, this number jumps and the change announces itself in
 * review instead of arriving as a hundred annotated files. Adding a genuinely new IO-in-a-loop test
 * is expected to bump it — by one, deliberately.
 *
 * The issue that asked for this rule measured 6 files needing an annotation. That is an undercount
 * of the same shape, not a different shape: `journal/session-end.test.ts` and `runs/run-store.test.ts`
 * need one too, making 8. The remaining 3 of those 11 — `project/project-tools.test.ts`,
 * `project/project-store.test.ts`, `multi-project.test.ts` — match the shape but already carry a
 * bound, so a search for files still lacking one could not see them.
 *
 * `session-end` is the one worth naming: it creates `DEFAULT_SESSION_RETENTION + 5` directories and
 * writes a file into each, which is more per-iteration IO than the 40-record loop that actually
 * broke Windows CI and prompted this issue.
 */
const EXPECTED_IO_LOOP_FILES = 12;

function testFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...testFiles(full));
    else if (entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

describe('heavy tests do not rely on the default timeout', () => {
  const sources = testFiles(PACKAGES).map((file) => ({ file, text: readFileSync(file, 'utf8') }));
  const heavy = sources.filter(({ text }) => HEAVY_LOOP.test(text));
  const ioLoop = sources.filter(({ text }) => REAL_TEMP_DIR.test(text) && hasAwaitInsideLoop(text));

  it('finds the heavy files at all — a vacuous rule is not a rule', () => {
    // Guards the guard: if the pattern stops matching, everything below passes for free.
    expect(heavy.length).toBeGreaterThan(0);
  });

  it('every file that builds thousands of nodes declares an explicit timeout', () => {
    const missing = heavy
      .filter(({ text }) => !EXPLICIT_TIMEOUT.test(text))
      .map(({ file }) => relative(PACKAGES, file));
    expect(missing).toEqual([]);
  });

  it('finds the IO-in-a-loop files, and only those — the rule is narrow on purpose', () => {
    // The count is the rule's blast radius, not decoration. See EXPECTED_IO_LOOP_FILES.
    expect(ioLoop.map(({ file }) => relative(PACKAGES, file))).toHaveLength(EXPECTED_IO_LOOP_FILES);
  });

  it('every file that does real IO inside a loop declares an explicit timeout', () => {
    const missing = ioLoop
      .filter(({ text }) => !EXPLICIT_TIMEOUT.test(text))
      .map(({ file }) => relative(PACKAGES, file));
    expect(
      missing,
      `These tests write to a real temp directory inside a loop. That is milliseconds on macOS and\n` +
        `Linux and much slower on a Windows runner, so vitest's 5s default decides the result instead\n` +
        `of the assertion. Give each one a named ${'`'}*_MS${'`'} bound — a generous ceiling, never a duration\n` +
        `assertion — the way HISTORY_WRITE_TIMEOUT_MS does in project/project-tools.test.ts.`,
    ).toEqual([]);
  });
});
