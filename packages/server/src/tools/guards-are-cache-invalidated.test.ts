/**
 * A guard that reads another package's files must be invalidated by them.
 *
 * Tests across this repo scan trees outside their own package: browser sources, the docs site,
 * `apps/`, `bench/`, the skills, the plugin manifests, the Rust crate. Turbo's cache key for a
 * `#test:unit` task is, by default, that package plus its dependency graph. So a change anywhere in
 * those other trees left the key untouched and the guards replayed a pass recorded against
 * different files.
 *
 * Reproduced before this was written: edit `packages/browser/src/dom/refs.ts`, run `pnpm test:unit`,
 * and `@reticlehq/server:test:unit` reports `cache hit, replaying logs`. The guard did not run.
 *
 * That is a false green in the gate itself, which is worse than the defects these guards catch: the
 * whole value of a source-scanning guard is that it fails locally, before CI. It surfaced when a
 * heavy browser test was added, the full local gate went green, and CI then failed on macos, windows
 * and verify at once, the signature of a real failure rather than a flake. The person running it did
 * nothing wrong; `pnpm test:unit` said success, and the guard is what is supposed to stop that.
 *
 * The fix is `inputs` on the task using `$TURBO_ROOT$`, which turbo 2.x supports and which
 * [#282](https://github.com/reticlehq/reticle/issues/282) doubted would work. It does; it was
 * measured. That beats `globalDependencies` (busts every task's cache on any change) and beats
 * moving the guards to a new tooling package (a bigger change for the same result).
 *
 * ## Why this checks every package and not one
 *
 * It used to check `@reticlehq/server` alone, and that is how the same hole reopened in
 * `@reticlehq/core`: `desktop-contract.test.ts` reads the Rust crate's `capture.rs` and `lib.rs` to
 * hold the daemon and the crate to one contract, core's task declared no `inputs`, and so breaking
 * that agreement replayed a green recorded against Rust the suite never opened.
 *
 * Fixing that one package the way the first was fixed would leave the rule exactly as findable as it
 * was the first time, which is to say not at all. A guard scoped to the package that happened to be
 * caught is a guard that catches each package once. So the scan is over every package that has a
 * `src`, and a new cross-package guard is covered on the day it lands rather than on the day
 * somebody notices.
 *
 * This test exists because the fix is a config file nobody reads. The next cross-package guard will
 * be written by someone who does not know turbo.json is load-bearing, and it would be silently
 * uncached from the day it lands, indistinguishable from working.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
// The same derivation the dependency-boundary guard uses, so the two cannot come to disagree about
// which packages exist. Both went blind once by keeping their own list of directories.
import { workspaceGlobs } from '../../../../scripts/check-boundaries.mjs';
import { execFileSync } from 'node:child_process';
import { join, relative, sep } from 'node:path';
import { REPO_ROOT } from '../repo-root.js';

const REPO = REPO_ROOT;

/** This file's own name, so its example strings are not read as real reads. */
const SELF = 'guards-are-cache-invalidated.test.ts';

interface TurboConfig {
  tasks?: Record<string, { inputs?: string[] }>;
  globalDependencies?: string[];
}

function turbo(): TurboConfig {
  return JSON.parse(readFileSync(join(REPO, 'turbo.json'), 'utf8')) as TurboConfig;
}

function declaredInputs(task: string): string[] {
  return turbo().tasks?.[task]?.inputs ?? [];
}

interface Package {
  /** The npm name, which is also the turbo task prefix. */
  readonly name: string;
  /** Where the package lives, relative to the repo root: `packages/server`, `engine`, and so on. */
  readonly path: string;
  readonly src: string;
  /**
   * The turbo task that actually RUNS this package's repo-scanning tests, and so is the task whose
   * cache key has to name what they read.
   *
   * For most packages that is `test:unit`. `@reticlehq/server` split the two halves apart: its
   * seventeen `$TURBO_ROOT$` globs meant a typo in a doc re-ran 6,700 tests to check 400 of them, so
   * the repo-scanning half moved to `test:guards` and took the wide input set with it. A package
   * that declares that script is asserted against it; one that does not is asserted against
   * `test:unit`, exactly as before. Read off the manifest rather than hardcoded, so the next package
   * to split is covered on the day it splits.
   */
  readonly task: string;
}

/**
 * Every directory the workspace covers, other than the local fixture apps.
 *
 * Read from `pnpm-workspace.yaml` rather than by looking in `packages/`. Not every package lives
 * there any more -- the specification and the rules that decide a verdict are top-level -- and a
 * scan that looks in one place goes on reporting success about the packages it can still see, which
 * reads as "these are fine" when it means "these were not looked at".
 */
function packageDirectories(): string[] {
  const yaml = readFileSync(join(REPO, 'pnpm-workspace.yaml'), 'utf8');
  const out: string[] = [];
  for (const glob of workspaceGlobs(yaml)) {
    if (glob.startsWith('apps')) continue;
    const [head, ...rest] = glob.split('/');
    const here = join(REPO, head ?? '');
    if (!existsSync(here)) continue;
    if (0 === rest.length) {
      out.push(head ?? '');
      continue;
    }
    const children = readdirSync(here, { withFileTypes: true }).filter((e) => e.isDirectory());
    for (const child of children) {
      if (1 === rest.length) {
        out.push(`${head ?? ''}/${child.name}`);
        continue;
      }
      const inner = readdirSync(join(here, child.name), { withFileTypes: true });
      for (const leaf of inner.filter((e) => e.isDirectory())) {
        out.push(`${head ?? ''}/${child.name}/${leaf.name}`);
      }
    }
  }
  return out;
}

/**
 * Every package with a `src` and a `test:unit` script.
 *
 * Driven off the workspace rather than a list, because a hand-maintained list of packages is the
 * same class of thing this file exists to stop: correct when written, silently short later.
 */
function packages(): Package[] {
  const out: Package[] = [];
  for (const path of packageDirectories()) {
    const src = join(REPO, path, 'src');
    const manifest = join(REPO, path, 'package.json');
    if (!existsSync(src) || !existsSync(manifest)) continue;
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as {
      name?: string;
      scripts?: Record<string, string>;
    };
    const name = parsed.name;
    if (undefined === name || undefined === parsed.scripts?.['test:unit']) continue;
    const half = undefined === parsed.scripts['test:guards'] ? 'test:unit' : 'test:guards';
    out.push({ name, path, src, task: `${name}#${half}` });
  }
  return out;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if ('node_modules' === entry || 'dist' === entry || entry === SELF) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * Repo-root paths a package's tests read, as written.
 *
 * Two spellings, because there are two ways a guard in this repo escapes its own directory and only
 * one of them was ever matched:
 *
 * - `join(REPO, 'apps'` — walk up from `import.meta.url` to the root and back down. What every
 *   guard in `@reticlehq/server` uses.
 * - `join(process.cwd(), '..', 'tauri'` — step sideways from the package root into a sibling. What
 *   `desktop-contract.test.ts` uses, and precisely the read that stayed uncached, because a matcher
 *   that only knew the first spelling reported no gap and meant no gap it could see.
 *
 * A guard that reached out some other way is still missed. That is a real limit, and it is why the
 * failure messages say what to add rather than only what is wrong.
 */
function readsRepo(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const paths = new Set<string>();
  for (const match of text.matchAll(/join\(\s*REPO,\s*'([^']+)'/g)) {
    const first = match[1];
    if (first !== undefined) paths.add(first);
  }
  for (const match of text.matchAll(/join\(\s*process\.cwd\(\),\s*'\.\.',\s*'([^']+)'/g)) {
    const sibling = match[1];
    if (sibling !== undefined) paths.add(`packages/${sibling}`);
  }
  return [...paths];
}

function repoPathsRead(pkg: Package): Set<string> {
  const paths = new Set<string>();
  for (const file of sourceFiles(pkg.src)) for (const path of readsRepo(file)) paths.add(path);
  return paths;
}

/**
 * Does any declared input cover this repo-root path?
 *
 * Prefix matching in BOTH directions, because the two are written at different granularities: a test
 * reading `apps/e2e/specs` is covered by an input of `apps` plus a wildcard tail, and a test reading
 * `packages` is covered by an input that names a wildcard package and its `src`. Neither is an exact
 * string match, and requiring one would demand an input entry per directory a guard happens to name.
 *
 * (Those globs are described rather than written out: a literal star-slash inside a block comment
 * ends it, which is exactly how this file first failed to parse.)
 *
 * A package's own tree is already covered by `$TURBO_DEFAULT$`, so it is never a gap.
 */
function isCovered(path: string, inputs: readonly string[], own: string): boolean {
  if (path.startsWith(own)) return true;
  const segments = (p: string): string[] => p.split('/').filter((s) => '' !== s && '**' !== s);
  const want = segments(path);
  return inputs.some((input) => {
    if (!input.startsWith('$TURBO_ROOT$/')) return false;
    const have = segments(input.replace('$TURBO_ROOT$/', ''));
    // One covers the other when every segment they share matches, wildcards included.
    const shared = Math.min(have.length, want.length);
    for (let i = 0; i < shared; i++) {
      if (have[i] !== '*' && have[i] !== want[i]) return false;
    }
    return true;
  });
}

/** Packages whose tests read outside their own tree, and so need a cache key that says so. */
const reaching = packages()
  .map((pkg) => ({
    pkg,
    reads: [...repoPathsRead(pkg)].filter((p) => !p.startsWith(pkg.path)),
  }))
  .filter(({ reads }) => reads.length > 0);

describe('cross-package guards are cache-invalidated by what they scan', () => {
  it('finds packages that read outside themselves (a pass over none proves nothing)', () => {
    // The scan is filesystem-driven, so a rename or a moved guard could quietly reduce it to zero
    // and every assertion below would pass by vacuity. That is the failure this whole file is about,
    // so it does not get to happen here.
    expect(reaching.length).toBeGreaterThan(1);
  });

  describe.each(reaching)('$pkg.name', ({ pkg, reads }) => {
    const task = pkg.task;

    it('declares inputs for the task at all', () => {
      expect(
        declaredInputs(task).length,
        `${task} has no \`inputs\` in turbo.json, so its cache key is this package plus its ` +
          `dependency graph, and its tests read trees this package does not depend on ` +
          `(${reads.join(', ')}). Without \`$TURBO_ROOT$\` inputs they replay a pass recorded ` +
          `against different files.`,
      ).toBeGreaterThan(1);
    });

    it('keeps $TURBO_DEFAULT$, so the package’s own sources still count', () => {
      // Listing `inputs` REPLACES the default set. Dropping this would mean a change to a package's
      // own source no longer invalidated its own tests, which is a far bigger hole than the one this
      // is fixing and would look identical from the outside.
      expect(declaredInputs(task)).toContain('$TURBO_DEFAULT$');
    });

    it('covers every repo-root path these tests actually read', () => {
      const inputs = declaredInputs(task);
      const missing = reads.filter((path) => !isCovered(path, inputs, pkg.path)).sort();

      expect(
        missing,
        `These tests read repo-root paths that no declared input covers, so a change to them ` +
          `leaves the cache key untouched and the guard replays an old pass. Add ` +
          `"$TURBO_ROOT$/<path>/**" to the \`inputs\` of ${task} in turbo.json:\n` +
          missing.map((p) => `  $TURBO_ROOT$/${p}`).join('\n'),
      ).toEqual([]);
    });
  });
});

/**
 * The split itself: nothing that reads the repo may be left in the narrow half.
 *
 * `@reticlehq/server#test:unit` no longer declares the wide input set — `test:guards` does. That is
 * only safe while the two halves are cut in the right place: a repo-scanning test that ends up on
 * the `test:unit` side has a cache key that says nothing about what it reads, which is the SAME
 * false green everything above this line exists to stop, reintroduced by the fix for it.
 *
 * `scripts/guard-tests.mjs` decides the cut, from a coarse rule (three `..` segments, or a sideways
 * `process.cwd(), '..'`). This checks that rule against the finer one used above — every file whose
 * actual READS this test can see must be on the guard side. The two disagreeing is not a style
 * difference; it is a file that is about to replay a stale pass.
 */
describe('the guard/unit split covers every test that reads the repo', () => {
  const split = packages().filter((pkg) => pkg.task.endsWith('#test:guards'));

  it('finds a package that has split at all (a pass over none proves nothing)', () => {
    expect(split.length).toBeGreaterThan(0);
  });

  describe.each(split)('$name', (pkg) => {
    const listed = new Set(
      execFileSync(process.execPath, [join(REPO, 'scripts', 'guard-tests.mjs'), 'list'], {
        cwd: join(REPO, pkg.path),
        encoding: 'utf8',
      })
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => '' !== line),
    );

    it('runs every repo-reading test in the guard half', () => {
      const missing = sourceFiles(pkg.src)
        .filter((file) => file.endsWith('.test.ts'))
        .filter((file) => 0 < readsRepo(file).length)
        .map((file) => relative(join(REPO, pkg.path), file).split(sep).join('/'))
        .filter((rel) => !listed.has(rel))
        .sort();

      expect(
        missing,
        `These tests read repo-root paths but scripts/guard-tests.mjs does not put them in ` +
          `${pkg.name}'s \`test:guards\` half, so they run under \`test:unit\` — whose cache key ` +
          `names none of it. Widen the ESCAPES rule in that script:\n` +
          missing.map((m) => `  ${m}`).join('\n'),
      ).toEqual([]);
    });
  });
});

/**
 * Two files change the meaning of every compile and every lint in the repo, and are inputs to
 * nothing.
 *
 * Tightening an eslint rule or changing a compiler option should re-run the tasks those settings
 * govern. Today both replay green everywhere, so the run that proves a stricter rule holds is a run
 * that never applied it. Unlike the per-task `inputs` above these genuinely are global, which is
 * what `globalDependencies` is for.
 */
describe('repo-wide settings invalidate the tasks they govern', () => {
  it.each(['tsconfig.base.json', 'eslint.config.mjs'])('%s is a global dependency', (file) => {
    expect(
      turbo().globalDependencies ?? [],
      `${file} changes the meaning of every compile or lint in the repo but is an input to nothing, ` +
        `so changing it replays every task green against the old settings.`,
    ).toContain(file);
  });
});
