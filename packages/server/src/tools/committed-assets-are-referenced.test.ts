import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { REPO_ROOT } from '../repo-root.js';

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

/**
 * Every tracked text file that could plausibly embed an image, as one blob.
 *
 * `git grep` would be faster, but it answers "is this string anywhere" including inside the asset
 * directories themselves — and one dead PNG naming another dead PNG is not a reference. Reading the
 * candidates directly keeps the question honest.
 */
const referencingText = (): string => {
  const files = execFileSync(
    'git',
    ['ls-files', '*.md', '*.mdx', '*.html', '*.json', '*.ts', '*.tsx', '*.mjs', '*.yml', '*.yaml'],
    { cwd: REPO, encoding: 'utf8' },
  )
    .split('\n')
    .filter((line) => line.length > 0)
    .filter((file) => !GUARDED_DIRS.some((dir) => file.startsWith(`${dir}/`)))
    // `git ls-files` reports the INDEX, so a file deleted in the working tree and not yet staged is
    // still listed. Reading it throws ENOENT and takes the whole guard down with an errno instead of
    // an answer — which is what happened while a package was being split out and every moved file
    // was a pending deletion. A path that is not there references no image.
    .filter((file) => existsSync(join(REPO, file)));

  return files.map((file) => readFileSync(join(REPO, file), 'utf8')).join('\n');
};

describe('committed images are referenced', () => {
  it('every tracked image under the guarded directories is named by some text file', () => {
    const haystack = referencingText();

    const orphans = tracked().filter((file) => {
      if (UNREFERENCED_BY_DESIGN.has(file)) return false;
      return !haystack.includes(basename(file));
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
