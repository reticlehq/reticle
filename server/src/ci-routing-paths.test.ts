import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT } from './machine/repo-root.js';

/**
 * Every path the CI router names must still exist.
 *
 * CI decides which expensive jobs to run by matching the changed files against lists of paths
 * in `scripts/ci/changes.mjs` (sourced from `tier-patterns.json`). If a path in one of those
 * lists stops existing -- a file renamed, a package split, a directory moved -- the list still
 * parses, still runs, and simply stops matching. The job it guards is then skipped, and the
 * `gate` aggregate counts a skip as success, so the pipeline goes green having quietly stopped
 * testing something.
 *
 * This is not hypothetical. `ci.yml` says so about itself: the release that turned `init` into an
 * install could edit every onboarding file "without the install gate running once", because those
 * paths were not on the list. That was a missing entry. This test covers the other direction, a
 * STALE entry, which looks identical from the outside and is what a refactor produces.
 *
 * What this checks is deliberately narrow: does the path exist? It cannot tell whether the list is
 * COMPLETE -- no test can, since that means knowing what a future job ought to care about. Catching
 * the stale half is cheap and worth having on its own.
 */
/**
 * Every OTHER workflow, because this guard read one file and the rot went to a different one.
 *
 * `ci.yml`'s filters are correct precisely because this test watches them, and nothing watched
 * the other ten. That asymmetry is what this closes.
 *
 * **What it does NOT close, stated because I wrote the opposite first.** The defect that sent me
 * here was a SHELL GLOB — a loop over a `packages` glob inside a run step — and this check reads
 * routing patterns, not shell. Reinstating that glob does not turn this test red; I tried it.
 * An empty loop is defended instead by the `checked` floor inside the workflow itself, which
 * fails the step when it inspects fewer packages than it should. Two failures, two mechanisms,
 * and neither one covers the other.
 *
 * Checked the same way and with the same tolerance: a routed path may name a file, a directory
 * or a filename prefix.
 */
const OTHER_WORKFLOWS = execFileSync('git', ['ls-files', '.github/workflows/*.yml'], {
  cwd: REPO_ROOT,
  encoding: 'utf8',
})
  .trim()
  .split('\n')
  .filter((path) => '' !== path && !path.endsWith('/ci.yml'));

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

/** Split a regex on `|` that is not inside parentheses. */
function topLevelAlternatives(pattern: string): string[] {
  const alts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of pattern) {
    if ('(' === ch) depth += 1;
    if (')' === ch) depth -= 1;
    if ('|' === ch && 0 === depth) {
      alts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  alts.push(current);
  return alts;
}

/** Every concrete path named by any of the router's match patterns. */
function routedPaths(source: string): string[] {
  const found = new Set<string>();
  for (const line of source.split('\n')) {
    const fromGrep = /grep -qE '\^\((.+)\)'/.exec(line)?.[1];
    const fromDump = /^[a-z]+=(.+)$/.exec(line)?.[1];
    const pattern = fromGrep ?? fromDump;
    if (pattern === undefined) continue;
    for (const alt of topLevelAlternatives(pattern)) {
      const wrapped = alt.startsWith('^') || alt.startsWith('(') ? alt : `(${alt})`;
      for (const variant of expandAlternations(wrapped)) {
        const cleaned = variant.replace(/\\\./g, '.').replace(/[$^]/g, '').trim();
        // A bare word with no separator is not a path; a trailing slash is a directory prefix.
        if (0 === cleaned.length || (!cleaned.includes('/') && !cleaned.includes('.'))) continue;
        found.add(cleaned.replace(/\/$/, ''));
      }
    }
  }
  return [...found].sort();
}

const ROUTER = join(REPO_ROOT, 'scripts', 'ci', 'changes.mjs');

function dumpedPatterns(): string {
  return execFileSync(process.execPath, [ROUTER, '--dump-patterns'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
}

/** Include new files when checking a working tree, before they have been staged. */
function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((line) => line.length > 0);
}

describe('the CI router only names paths that exist', () => {
  const paths = routedPaths(dumpedPatterns());
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

  it('no other workflow names a path that matches nothing', () => {
    const stale: string[] = [];
    for (const relative of OTHER_WORKFLOWS) {
      const text = readFileSync(join(REPO_ROOT, relative), 'utf8');
      // Comments explain what a path USED to be, which is the opposite of a stale reference.
      const live = text
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('#'))
        .join('\n');
      for (const path of routedPaths(live)) {
        if (DECLARED_ABSENT[path] !== undefined) continue;
        if (!matchesSomething(path)) stale.push(`${relative}: ${path}`);
      }
    }
    expect(
      stale.sort(),
      'these paths are named in a workflow and match nothing. A filter that matches nothing ' +
        'skips its job, and a loop over a glob that matches nothing exits 0 having done no ' +
        'work — both report success.',
    ).toEqual([]);
  });

  it('every routed path still matches a real file', () => {
    const stale = paths.filter(
      (path) => DECLARED_ABSENT[path] === undefined && !matchesSomething(path),
    );
    expect(
      stale,
      'These paths are named in scripts/ci/tier-patterns.json but match nothing in the repo. The job ' +
        'each one routes to can no longer be triggered by a change to it, and a skipped job counts ' +
        'as success. Update the pattern to the new location.',
    ).toEqual([]);
  });

  it('can tell that a made-up path matches nothing (negative control)', () => {
    // Assembled from pieces so the literal never appears in this file, which would otherwise make
    // the search find its own probe.
    const invented = ['packages/', 'not', '-a-real', '-package'].join('');
    expect(matchesSomething(invented)).toBe(false);
  });
});

// Execute the router script. Incident #1514: a path no rule matched turned the expensive tiers
// OFF, so a new adapters/realm/* ran almost nothing before merge. A large diff must not drop a
// matching file at the start either.
describe('CI routing decisions', () => {
  const route = (paths: string[]): Record<string, string> => {
    const temporary = mkdtempSync(join(tmpdir(), 'reticle-ci-routing-'));
    const outputPath = join(temporary, 'output');
    try {
      execFileSync(process.execPath, [ROUTER], {
        input: `${paths.join('\n')}\n`,
        encoding: 'utf8',
        cwd: REPO_ROOT,
        env: { ...process.env, GITHUB_OUTPUT: outputPath },
      });
      const flags: Record<string, string> = {};
      for (const line of readFileSync(outputPath, 'utf8').trim().split('\n')) {
        const [key, value] = line.split('=');
        if (key === undefined || value === undefined)
          throw new Error(`invalid routing output: ${line}`);
        flags[key] = value;
      }
      return flags;
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  };

  it('keeps a docs-only change out of the product and Rust jobs', () => {
    expect(route(['docs/usage.md'])).toMatchObject({
      e2e: 'false',
      install: 'false',
      rust: 'false',
    });
  });

  it.each([
    'init/src/run.ts',
    'server/src/command/cli/setup-mcp-cli.ts',
    'scripts/pack-install-gate.mjs',
  ])('%s exercises installation', (path) => {
    expect(route([path]).install).toBe('true');
  });

  it('checks a change to the control itself', () => {
    expect(route(['apps/e2e/install-control.mjs'])).toMatchObject({
      gateself: 'true',
      install: 'true',
    });
  });

  it('runs Rust for the crate', () => {
    expect(route(['adapters/realm/tauri/src/lib.rs']).rust).toBe('true');
  });

  it('turns every tier on for an unrouted new directory', () => {
    expect(route(['brand-new-package/src/index.ts'])).toMatchObject({
      e2e: 'true',
      install: 'true',
      windows: 'true',
      bench: 'true',
      desktop: 'true',
      rust: 'true',
      break: 'true',
      launchers: 'true',
    });
  });

  it('runs break jobs when init changes', () => {
    expect(route(['init/src/run.ts']).break).toBe('true');
  });

  it('runs the launchers for install/ and not for a server change', () => {
    // The launchers install the PUBLISHED CLI from npm; a server edit cannot change their answer.
    expect(route(['install/install.sh']).launchers).toBe('true');
    expect(route(['server/src/command/cli/setup-mcp-cli.ts']).launchers).toBe('false');
  });

  it('leaves install, desktop and bench to the narrow patterns for a package change', () => {
    // The tier map only adds e2e and windows. A browser SDK file outside the desktop-only list
    // must not turn desktop on, or most PRs pay for the slowest job in ci.yml.
    expect(route(['adapters/realm/browser/src/index.ts'])).toMatchObject({
      e2e: 'true',
      windows: 'true',
      desktop: 'false',
    });
  });

  it('does not lose a matching file at the start of a large merge-group diff', () => {
    const paths = [
      'core/src/index.ts',
      ...Array.from({ length: 20000 }, (_, i) => `docs/changed-${String(i)}.md`),
    ];
    expect(route(paths)).toMatchObject({ e2e: 'true', install: 'true', bench: 'true' });
  });

  it('turns every tier on for a new adapters/realm that no tier names', () => {
    // Assembled so the literal directory is not a tracked path this test invents on disk.
    const probe = ['adapters/realm/', 'zz-probe', '/x.ts'].join('');
    expect(route([probe])).toMatchObject({
      e2e: 'true',
      install: 'true',
      windows: 'true',
      bench: 'true',
      desktop: 'true',
      rust: 'true',
      break: 'true',
      conformance: 'true',
      gateself: 'true',
    });
  });

  it('ORs the tier-map for a known workspace package', () => {
    expect(route(['adapters/realm/cli/src/index.ts'])).toMatchObject({
      e2e: 'true',
      windows: 'true',
    });
  });

  it('turns every tier on when any workflow file changes', () => {
    expect(route(['.github/workflows/dco.yml'])).toMatchObject({
      e2e: 'true',
      rust: 'true',
      break: 'true',
      windows: 'true',
    });
  });
});
