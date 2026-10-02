import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { basename, extname } from 'node:path';
import { REPO_ROOT } from '@/machine/repo-root.js';

const REPO = REPO_ROOT;

/**
 * A committed binary that nothing embeds is dead weight nobody can see.
 *
 * `assets/readme/` is written by `assets/benchmarks/render.mjs`, which renders EVERY card in
 * `assets/benchmarks/src/*.html` to a 2x PNG. It has no used-filter, so cards that no document
 * embeds were rendered and committed anyway — nineteen files, 34 MB, none of them reachable from a
 * single markdown page. Deleting them is not enough on its own: the next `render.mjs` run puts them
 * straight back, which is exactly how they accumulated.
 *
 * So the rule is a red build rather than a habit. The same shape as `docs-index-coverage.test.ts`,
 * applied to bytes instead of pages: an image earns its place in git by being referenced from text.
 *
 * This deliberately does NOT stop anyone rendering a card locally — `render.mjs` still writes every
 * one. It stops an unreferenced render being COMMITTED, which is the part that costs everybody a
 * clone.
 */

/** Directories whose committed images must be reachable from some text file. */
const GUARDED_DIRS = ['assets/readme', 'assets/logo', 'docs/images'] as const;

const IMAGE_EXTENSIONS = new Set(['.png', '.gif', '.webp', '.jpg', '.jpeg', '.svg']);

/**
 * Files that are deliberately committed without an inbound reference.
 *
 * Each entry needs a reason. An empty allowlist is the healthy state; an entry with no explanation
 * is how this guard would rot into the vacuous kind it exists to prevent.
 */
const UNREFERENCED_BY_DESIGN: ReadonlyMap<string, string> = new Map([
  [
    'docs/logo/reticle-wordmark-dark.svg',
    'Mintlify reads the logo pair out of docs.json by path, and some themes resolve it without naming the file in any page.',
  ],
]);

const tracked = (): string[] =>
  execFileSync('git', ['ls-files', ...GUARDED_DIRS], { cwd: REPO, encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.length > 0)
    .filter((file) => IMAGE_EXTENSIONS.has(extname(file).toLowerCase()));

/** The text files that could plausibly embed an image. */
const TEXT_PATHSPECS = [
  '*.md',
  '*.mdx',
  '*.html',
  '*.json',
  '*.ts',
  '*.tsx',
  '*.mjs',
  '*.yml',
  '*.yaml',
] as const;

/**
 * Which of these basenames appear in tracked text, in ONE pass.
 *
 * This used to read every tracked text file into a single blob and run `includes` over it per
 * image. The note here said `git grep` "would be faster, but it answers 'is this string anywhere'
 * including inside the asset directories themselves — and one dead PNG naming another dead PNG is
 * not a reference". The objection is right and a pathspec settles it: `:(exclude)` drops the
 * guarded directories from the search, which is the same exclusion the blob did by filtering paths.
 *
 * It had to change because the blob was not merely slow, it was RED. MEASURED on Windows: the test
 * timed out at its 60 s bound inside the full guard suite, where the file reads compete with every
 * other package's workers; the same search as one `git grep` answers in 0.3 s. Raising the bound
 * was the other option, and this guard was already the slowest thing in the suite.
 *
 * `--cached` searches the INDEX rather than the working tree, which also removes the hazard the old
 * code needed an `existsSync` filter for: `git ls-files` lists a file deleted-but-not-staged, and
 * reading it threw ENOENT and took the whole guard down with an errno instead of an answer.
 */
const referencedAmong = (names: readonly string[]): ReadonlySet<string> => {
  if (0 === names.length) return new Set();
  try {
    const out = execFileSync(
      'git',
      [
        'grep',
        '--cached',
        '-h',
        '-o',
        '-F',
        ...names.flatMap((name) => ['-e', name]),
        '--',
        ...TEXT_PATHSPECS,
        ...GUARDED_DIRS.map((dir) => `:(exclude)${dir}/*`),
      ],
      { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    return new Set(out.split('\n').filter((line) => line.length > 0));
  } catch (thrown) {
    // `git grep` exits 1 when nothing matched at all, which is an answer and not a failure.
    if (1 === (thrown as { status?: number }).status) return new Set();
    throw thrown;
  }
};

// One `git grep` over the index, which is why the bound below is now generous rather than tight:
// the work it covers takes a fraction of a second. It was 60 s of reading every tracked text file,
// and that went red under the full suite. See the note on `referencedAmong`.
describe('committed images are referenced', { timeout: 60_000 }, () => {
  it('every tracked image under the guarded directories is named by some text file', () => {
    const images = tracked();
    const referenced = referencedAmong([...new Set(images.map((file) => basename(file)))]);

    const orphans = images.filter((file) => {
      if (UNREFERENCED_BY_DESIGN.has(file)) return false;
      return !referenced.has(basename(file));
    });

    expect(
      orphans,
      `These images are committed but nothing references them. Either embed them or delete them — ` +
        `re-rendering a card does not make it worth a clone:\n  ${orphans.join('\n  ')}`,
    ).toEqual([]);
  });

  it('names a reason for every deliberate exception', () => {
    for (const [file, reason] of UNREFERENCED_BY_DESIGN) {
      expect(reason.length, `${file} is allowlisted with no reason`).toBeGreaterThan(20);
    }
  });
});
