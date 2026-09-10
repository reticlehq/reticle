import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './repo-root.js';

/**
 * Every path the CI router names must still exist.
 *
 * CI decides which expensive jobs to run by matching the changed files against lists of paths
 * written into `ci.yml`. If a path in one of those lists stops existing -- a file renamed, a package
 * split, a directory moved -- the list still parses, still runs, and simply stops matching. The job
 * it guards is then skipped, and the `gate` aggregate counts a skip as success, so the pipeline goes
 * green having quietly stopped testing something.
 *
 * This is not hypothetical. `ci.yml` says so about itself: the release that turned `init` into an
 * install could edit every onboarding file "without the install gate running once", because those
 * paths were not on the list. That was a missing entry. This test covers the other direction, a
 * STALE entry, which looks identical from the outside and is what a refactor produces.
 *
 * It matters most right now because the v3 work moves several of the exact files named below.
 *
 * What this checks is deliberately narrow: does the path exist? It cannot tell whether the list is
 * COMPLETE -- no test can, since that means knowing what a future job ought to care about. Catching
 * the stale half is cheap and worth having on its own.
 */
const WORKFLOW = join(REPO_ROOT, '.github', 'workflows', 'ci.yml');

/** Paths that are allowed to be absent, each with the reason. Empty, and it should stay empty. */
const DECLARED_ABSENT: Record<string, string> = {};

/**
 * Expand one match pattern into the concrete paths it can match.
 *
 * The patterns nest, like `packages/(init|server/src/setup)/` and `apps/(electron|tauri)-smoke/`, so
 * splitting on `|` alone produces fragments rather than paths. This expands the innermost group
 * first and repeats, which turns one pattern into the full list of paths a reader would say it
 * names. Only the small alternation-and-literal subset those lines actually use is supported; there
 * is no attempt at general regex, because a parser larger than the thing it guards is its own risk.
 */
function expandAlternations(pattern: string): string[] {
  let variants = [pattern];
  // Innermost group first: it has no nested parentheses inside it.
  const innermost = /\(([^()]*)\)/;
  while (variants.some((variant) => innermost.test(variant))) {
    variants = variants.flatMap((variant) => {
      const match = innermost.exec(variant);
      if (null === match) return [variant];
      const [whole, alternatives = ''] = match;
      return alternatives.split('|').map((choice) => variant.replace(whole, choice));
    });
  }
  return variants;
}

/** Every concrete path named by any of the router's match patterns. */
function routedPaths(workflow: string): string[] {
  const found = new Set<string>();
  for (const line of workflow.split('\n')) {
    const pattern = /grep -qE '\^\((.+)\)'/.exec(line)?.[1];
    if (pattern === undefined) continue;
    for (const variant of expandAlternations(`(${pattern})`)) {
      const cleaned = variant.replace(/\\\./g, '.').replace(/[$^]/g, '').trim();
      // A bare word with no separator is not a path; a trailing slash is a directory prefix.
      if (0 === cleaned.length || (!cleaned.includes('/') && !cleaned.includes('.'))) continue;
      found.add(cleaned.replace(/\/$/, ''));
    }
  }
  return [...found].sort();
}

/** Every file git tracks, as one string per line, for cheap prefix matching. */
function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.length > 0);
}

describe('the CI router only names paths that exist', () => {
  const workflow = readFileSync(WORKFLOW, 'utf8');
  const paths = routedPaths(workflow);
  const tracked = trackedFiles();

  // A routed path names either a file, a directory, or a file-name PREFIX (ci.yml routes on
  // `apps/e2e/install-gate`, which is meant to catch `install-gate.mjs`). All three count.
  const matchesSomething = (path: string): boolean =>
    tracked.some((file) => file === path || file.startsWith(`${path}/`) || file.startsWith(path));

  it('finds the routing patterns at all', () => {
    // Without this, a change to how ci.yml writes its filters would empty the list and every check
    // below would pass by having nothing to check.
    expect(paths.length).toBeGreaterThan(10);
    expect(paths).toContain('adapters/realm/tauri');
  });

  it('every routed path still matches a real file', () => {
    const stale = paths.filter(
      (path) => DECLARED_ABSENT[path] === undefined && !matchesSomething(path),
    );
    expect(
      stale,
      'These paths are named in .github/workflows/ci.yml but match nothing in the repo. The job ' +
        'each one routes to can no longer be triggered by a change to it, and a skipped job counts ' +
        'as success. Update the pattern in ci.yml to the new location.',
    ).toEqual([]);
  });

  it('can tell that a made-up path matches nothing (negative control)', () => {
    // Assembled from pieces so the literal never appears in this file, which would otherwise make
    // the search find its own probe.
    const invented = ['packages/', 'not', '-a-real', '-package'].join('');
    expect(matchesSomething(invented)).toBe(false);
  });
});
