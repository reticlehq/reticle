import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../../machine/repo-root.js';

/**
 * The map at the top of CLAUDE.md points at directories that are there.
 *
 * That block is the first thing anybody reads to find out where anything lives, and it is the
 * first thing an agent reads before touching this repository. It named seven directories that
 * do not exist: `packages/react`, `packages/vite-plugin`, `packages/babel-plugin`,
 * `packages/next`, `packages/electron`, `packages/tauri` and `eslint-plugin`, all of which
 * moved under `adapters/` and none of which was updated here. It also had no line at all for
 * `openreality`, `engine` or `conformance`.
 *
 * A wrong map is worse than no map, and this one has a measurable cost already recorded: a
 * repository-wide grep once missed fifty-eight tracked files because the searcher was looking
 * where the map said rather than where the code was.
 *
 * Only the first column is checked. What a package is FOR is prose and cannot be verified;
 * whether the path exists is a fact, and it is the half that rots when directories move.
 */

const CLAUDE_MD = 'CLAUDE.md';

/** The fenced block holding the layout table, which is the first one in the file. */
function layoutBlock(): string {
  const text = readFileSync(join(REPO_ROOT, CLAUDE_MD), 'utf8');
  const open = text.indexOf('```');
  const close = text.indexOf('```', open + 3);
  return -1 === open || -1 === close ? '' : text.slice(open + 3, close);
}

/** The leading path on each line, for lines that start with one. */
function mappedPaths(): string[] {
  return layoutBlock()
    .split('\n')
    .map((line) => /^([A-Za-z][\w./-]*)\s{2,}/.exec(line)?.[1] ?? '')
    .filter((path) => '' !== path)
    .map((path) => path.replace(/\/$/, ''))
    .sort();
}

/**
 * Is git tracking anything under this path, or is it deliberately absent from a clone?
 *
 * Two different absences look identical to `existsSync`: a directory that MOVED (a real defect in
 * the map) and one that is gitignored on purpose. Only the first should fail.
 */
function isTracked(path: string): boolean {
  const listed = execFileSync('git', ['ls-files', '--', path], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).trim();
  return '' !== listed;
}

/**
 * Is this path ignored on purpose?
 *
 * Split out of `isTracked`, because folding the two together hid a CI-only failure for as long as
 * this guard has existed. `plan/` is gitignored: it is on every developer's disk and in NOBODY's
 * clone. The check was `!existsSync(path) || !isTracked(path)`, and the `existsSync` half fires
 * first in a fresh checkout — so the ignore exemption could never be reached there, and the guard
 * passed locally and failed in CI every single run.
 *
 * A path git ignores is DELIBERATELY absent from a clone, so "does it exist" is not a question worth
 * asking about it on any machine.
 *
 * Asked BOTH ways, and the trailing slash is the whole reason this was invisible. The rule is
 * `/plan/` — a directory-only pattern — and `git check-ignore plan` matches it on a developer's disk
 * ONLY because the directory is there for git to see. In a fresh clone the path does not exist, git
 * cannot tell it would be a directory, and the match fails. The guard was therefore structurally
 * incapable of passing in CI while passing on every machine that could have noticed.
 */
/**
 * Answered for EVERY path in one `git check-ignore --stdin`, not one spawn per spelling per path.
 *
 * The per-path version spawned up to two processes for each of twenty-odd entries, and process
 * creation — not the matching — was all of the cost. It timed out at 8.1s against vitest's 5s
 * default while a benchmark had the CPU, which is the load-only flake this repo already warns
 * about: a failure that says nothing about the code and only ever appears where machines are busy,
 * i.e. in CI. Raising the timeout would have hidden it; one spawn removes it.
 *
 * `--stdin` prints back the paths that ARE ignored and exits non-zero when none of them is, which
 * is a normal answer here rather than an error.
 */
const ignoredPaths = (): ReadonlySet<string> => {
  const candidates = mappedPaths().flatMap((path) => [path, `${path}/`]);
  try {
    const matched = execFileSync('git', ['check-ignore', '--stdin'], {
      cwd: REPO_ROOT,
      input: candidates.join('\n'),
      encoding: 'utf8',
    });
    return new Set(matched.split('\n').map((line) => line.replace(/\/$/, '').trim()));
  } catch {
    // Non-zero means nothing matched — every mapped path is expected to exist.
    return new Set();
  }
};

describe('the map at the top of CLAUDE.md', () => {
  it('finds paths to check, so a pass is not a pass over nothing', () => {
    // A changed fence, a reformatted table or a stricter regex would silently empty this.
    expect(mappedPaths().length).toBeGreaterThan(15);
    expect(mappedPaths()).toContain('server');
  });

  it('names only directories that exist in a fresh clone', () => {
    // `existsSync` alone asks the WRONG filesystem. `plan/` is in the map and is always
    // gitignored, so it is on every developer's disk and in nobody's clone: this assertion passed
    // locally for everyone and failed the first time CI ever ran, on a checkout that had no
    // `plan/` because no checkout ever does.
    //
    // The exemption is derived rather than listed. A path git ignores is deliberately absent from
    // a clone, so "does it exist" is not the question to ask about it — and deriving means the
    // next deliberately-untracked entry needs no edit here, while a directory that is simply GONE
    // is not ignored and still fails.
    const ignored = ignoredPaths();
    const absent = mappedPaths().filter(
      // Exempt FIRST. Asking whether an ignored path exists answers a question about this machine
      // rather than about the map, and the answer differs between a developer's disk and a clone.
      (path) => !ignored.has(path) && (!existsSync(join(REPO_ROOT, path)) || !isTracked(path)),
    );
    expect(
      absent,
      `${CLAUDE_MD} points at these and a fresh clone does not have them. This block is the ` +
        'first thing anybody reads to find out where code lives, and a wrong map sends every ' +
        'reader and every agent to the wrong place. A path that is deliberately gitignored (like ' +
        '`plan/`) is exempt automatically — if one is listed here, git is tracking nothing under it.',
    ).toEqual([]);
  });

  it('has a line for every workspace package', () => {
    // The other half: a package nobody mapped is a package nobody finds. Read from the
    // manifests rather than listed here, so adding one is enough to be asked for.
    const mapped = new Set(mappedPaths());
    const missing: string[] = [];
    for (const manifest of trackedManifests()) {
      const dir = manifest.replace('/package.json', '');
      if (dir.startsWith('apps/')) continue;
      if (!mapped.has(dir)) missing.push(dir);
    }
    expect(
      missing.sort(),
      `${CLAUDE_MD} has no line for these packages. A package nobody mapped is a package ` +
        'nobody finds.',
    ).toEqual([]);
  });
});

function trackedManifests(): string[] {
  return execFileSync('git', ['ls-files', '*/package.json'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .filter((path: string) => '' !== path);
}
