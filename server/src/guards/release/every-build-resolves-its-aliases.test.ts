/**
 * No package's build may leave `@/…` in its own dist. Second occurrence of the same defect.
 *
 * ── THE INCIDENT, TWICE ─────────────────────────────────────────────────────────────────────────
 * `scripts/alias-dist.mjs` exists because `pnpm gate:install` could not start: core's prepack died
 * on `Cannot find package '@/vocabulary' imported from open-verification/dist/spi/realm.js`. The
 * cause is written on that file — `tsc -b` builds the PROJECT REFERENCES, `tsc-alias` reads one
 * tsconfig and rewrites one `outDir`, so a dependent's build re-emits its dependency's dist with the
 * alias back in it and nothing puts it back.
 *
 * The fix was applied to eight packages and MISSED two. `open-verification` was one of them — the
 * package at the bottom of the graph, which every other package's `tsc -b` cascades into, so the
 * most exposed of the thirteen. It surfaced again on a push to main:
 *
 *   Failed: @reticlehq/example-remix#typecheck
 *   Cannot find package '@/vocabulary' imported from open-verification/dist/spi/adjudicator.js
 *
 * Same package, same alias, a sibling file. Turbo caches `dist/**`, so once a build produced the
 * broken output it was restored on every later run — intermittent in origin, permanent in effect.
 *
 * ── WHY THE EXISTING GUARD COULD NOT SEE IT ─────────────────────────────────────────────────────
 * `prepare-dist.mjs` already refuses to PACK a dist containing `@/`, which is why the published
 * tarballs were clean both times and no user was ever affected. It checks the dist being packed;
 * the broken one belonged to a dependency, built later. The working tree is the thing nobody was
 * checking, and it is what every gate, every example app and every local run reads.
 *
 * This reads the built output of every publishable package and fails on the first `@/` in it. It
 * needs a build to have happened — which `test:unit` always has, because turbo runs `build` first.
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '@/machine/repo-root.js';

/** Every workspace package that publishes, read from the manifests rather than listed here. */
function publishableDirs(): string[] {
  const out = execFileSync(
    'git',
    ['ls-files', 'package.json', '*/package.json', '*/*/package.json', '*/*/*/package.json'],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  const dirs: string[] = [];
  for (const rel of out.split('\n').filter((l) => l.length > 0)) {
    const raw = readFileSync(join(REPO_ROOT, rel), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if ('object' !== typeof parsed || null === parsed) continue;
    const manifest = parsed as Record<string, unknown>;
    if (true === manifest['private'] || 'string' !== typeof manifest['name']) continue;
    const dir = rel.replace(/\/?package\.json$/, '');
    if ('' !== dir) dirs.push(dir);
  }
  return dirs;
}

/** Built JS and declaration files under a dist, ignoring maps (a map naming `@/` is harmless). */
function builtFiles(dist: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (/\.(js|cjs|mjs|d\.ts|d\.cts)$/.test(entry)) found.push(full);
    }
  };
  walk(dist);
  return found;
}

/** An unrewritten alias in an import or require — not the string `@/` appearing in prose. */
const UNRESOLVED_ALIAS = /(?:from\s+['"]@\/|require\(['"]@\/|import\(['"]@\/)/;

/*
 * Comments go first, and this guard failed on one before it ever found a real defect:
 *
 *   // Re-exported so existing imports (and the CLI tests) keep resolving from '@/cli.js'.
 *
 * That line is a note about a rename, in `server/dist/command/cli.js`, and nothing imports through
 * it. Matching it would have made the guard red on a correct build — and a guard that cries wolf on
 * prose gets the prose deleted, which is the worse outcome of the two.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

describe('a build leaves no @/ alias in any dist', () => {
  const dirs = publishableDirs().filter((d) => existsSync(join(REPO_ROOT, d, 'dist')));

  it('finds built packages to check, so this cannot pass over an empty list', () => {
    // The negative control. Run before any build, every dist is absent and the loop below checks
    // nothing — which would read as "no package has the defect".
    expect(dirs.length, 'no dist directories found — has anything been built?').toBeGreaterThan(5);
  });

  it('no built file imports through an unresolved alias', () => {
    const broken: string[] = [];
    for (const dir of dirs) {
      for (const file of builtFiles(join(REPO_ROOT, dir, 'dist'))) {
        if (UNRESOLVED_ALIAS.test(withoutComments(readFileSync(file, 'utf8')))) {
          broken.push(file.slice(REPO_ROOT.length + 1));
        }
      }
    }
    expect(
      broken.slice(0, 10),
      'these built files still import through `@/`, so anything reading them fails with ' +
        'ERR_MODULE_NOT_FOUND. A dependent package’s `tsc -b` re-emitted a dependency’s ' +
        'dist after that dependency had already aliased it: the package’s build must run ' +
        'scripts/alias-dist.mjs (which walks the reference graph) rather than bare `tsc-alias`.',
    ).toEqual([]);
  });
});
