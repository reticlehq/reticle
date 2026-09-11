import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../../machine/repo-root.js';

/**
 * Why a guard that reads `git ls-files` can disagree with the editor in front of you.
 *
 * It cost a blocked commit and a wrong diagnosis: `verify` passed on an untracked new file,
 * `git add` made it tracked, and the identical test then failed in the hook. I blamed turbo's
 * cache, started widening its inputs, and measured three cases that all invalidated correctly
 * before noticing the real cause. The message says it now so nobody repeats that.
 */
const STAGED_NOTE =
  'A new file is invisible here until it is STAGED: this counts what git tracks, so `pnpm verify` before `git add` and the pre-commit hook after it are asking about two different trees. If you just created or deleted one, stage it and run this again.\n\n';

/**
 * Every filename a published package exposes through a wildcard subpath.
 *
 * `@reticlehq/engine` exports `"./evidence/*.js"` and three siblings. A pattern subpath
 * substitutes across slashes, so moving `evidence/blind-spots.ts` into `evidence/gaps/` keeps
 * resolving — for us. For anybody who wrote `import ... from '@reticlehq/engine/evidence/
 * blind-spots.js'`, the path they were given no longer exists. Nothing in this repository goes
 * red: the type checker is happy, the build is happy, the tests are happy, and the breakage is
 * entirely on the other side of the package boundary.
 *
 * That is the same shape as the tidying this list was written during. A five-file family in
 * `evidence/` was SAFE by every internal measure and was left alone for exactly this reason,
 * and a rule that lives only in somebody's notes is a rule the next contributor never sees.
 *
 * So the filenames are pinned. Adding one is a new public entry point; removing or moving one
 * is a breaking change. Both are fine to do deliberately — update this list in the same commit,
 * and say so in the changelog, which for a rename means naming the old path and the new one.
 *
 * Root-barrel packages are deliberately absent. `@reticlehq/browser` exports `"."` and nothing
 * else, so every file under its `src/` is private and may be rearranged freely; that is why the
 * SDK grouping in the same sweep was safe and this one was not.
 */

interface PublicSurface {
  readonly package: string;
  /** The export keys that make filenames public, for the error message. */
  readonly patterns: readonly string[];
  readonly files: readonly string[];
}

const PINNED: readonly PublicSurface[] = [
  {
    package: 'engine',
    patterns: ['./question/*.js', './disagreement/*.js', './window/*.js', './evidence/*.js'],
    files: [
      'disagreement/body-failures.ts',
      'disagreement/contradiction-folds.ts',
      'disagreement/contradictions.ts',
      'disagreement/echo-mismatch.ts',
      'disagreement/reconcile.ts',
      'disagreement/stale-response.ts',
      'disagreement/unit-mismatch.ts',
      'evidence/accepted-write.ts',
      'evidence/already-true.ts',
      'evidence/blind-spots.ts',
      'evidence/body-capture-remedy.ts',
      'evidence/gap-ledger.ts',
      'evidence/honesty.ts',
      'evidence/instrumentation-gaps.ts',
      'evidence/observability.ts',
      'evidence/page-teardown.ts',
      'evidence/uncaptured-bodies.ts',
      'evidence/undeclared-change.ts',
      'evidence/unread-outcome.ts',
      'evidence/unsettled.ts',
      'evidence/verified.ts',
      'question/declared.ts',
      'question/lineage.ts',
      'question/predicate/net-evidence.ts',
      'question/predicate/observed-in-window.ts',
      'question/predicate/predicate-asks.ts',
      'question/predicate/predicate-console.ts',
      'question/predicate/predicate-element.ts',
      'question/predicate/predicate-eval.ts',
      'question/predicate/predicate-parse.ts',
      'question/predicate/predicate-precheck.ts',
      'question/predicate/predicate-request-body.ts',
      'question/predicate/predicate-route.ts',
      'question/predicate/predicate-schema.ts',
      'question/predicate/predicate-to-links.ts',
      'question/predicate/predicate.ts',
      'question/predicate/split-text-miss.ts',
      'question/predicate/testid-near-miss.ts',
      'question/reaction.ts',
      'window/adversary.ts',
      'window/ambient.ts',
      'window/engine-host.ts',
      'window/event-filters.ts',
      'window/json-salvage.ts',
      'window/network-detail-merge.ts',
      'window/ring-buffer.ts',
    ],
  },
];

/** Source files under the directories a wildcard pattern opens up. */
function publicFiles(pkg: string, patterns: readonly string[]): string[] {
  const roots = patterns.map((pattern) => pattern.replace(/^\.\//, '').replace(/\/\*\.js$/, ''));
  const tracked = execFileSync('git', ['ls-files', `${pkg}/src`], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .filter((line) => '' !== line);
  return tracked
    .map((path) => path.slice(`${pkg}/src/`.length))
    .filter((path) => path.endsWith('.ts') && !path.endsWith('.test.ts'))
    .filter((path) => roots.some((root) => path.startsWith(`${root}/`)))
    .sort();
}

describe('what a published package promises by filename', () => {
  it('the packages with wildcard subpaths are the ones pinned here', () => {
    // A package that grows a wildcard export becomes a surface nobody is watching. This finds
    // them from the manifests rather than trusting the list above to stay complete. JSON
    // patterns are excluded: those expose generated schema files, not source filenames.
    const manifests = execFileSync('git', ['ls-files', '*/package.json'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
      .filter((path) => '' !== path && !path.startsWith('apps/'));
    const exposing: string[] = [];
    for (const path of manifests) {
      const manifest = JSON.parse(readFileSync(join(REPO_ROOT, path), 'utf8')) as {
        private?: boolean;
        exports?: Record<string, unknown>;
      };
      if (true === manifest.private) continue;
      const wildcards = Object.keys(manifest.exports ?? {}).filter(
        (key) => key.includes('*') && key.endsWith('.js'),
      );
      if (0 < wildcards.length) exposing.push(path.replace('/package.json', ''));
    }
    expect(
      exposing.sort(),
      'a published package exposes source filenames through a wildcard subpath and is not ' +
        'pinned below. Every file under those directories is now a public import path.',
    ).toEqual(PINNED.map((surface) => surface.package).sort());
  });

  for (const surface of PINNED) {
    it(`${surface.package} exposes exactly the files recorded here`, () => {
      const found = publicFiles(surface.package, surface.patterns);
      // Vacuity: a broken listing would return nothing and match nothing, and an empty
      // expectation would pass.
      expect(found.length).toBeGreaterThan(10);
      expect(
        found,
        STAGED_NOTE +
          `${surface.package} publishes ${surface.patterns.join(', ')}, so each of these filenames ` +
          'is an import path somebody outside this repository may already have written. Adding ' +
          'one is a new public entry point; moving or removing one is a breaking change that ' +
          'nothing here will otherwise notice. Update this list and the changelog together.',
      ).toEqual([...surface.files]);
    });
  }
});
