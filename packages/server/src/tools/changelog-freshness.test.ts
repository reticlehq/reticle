/**
 * The changelog has to be roughly as old as the code it describes.
 *
 * Nothing in this repo notices when it stops being: the release notes keep describing a release that
 * no longer exists while feature after feature lands underneath them. That is not a cosmetic problem.
 * `CHANGELOG.md` is what a user reads to decide whether to upgrade and what a maintainer reads to
 * write the release, and a changelog that is silently 65 commits behind reads exactly like one that
 * is current.
 *
 * Deliberately a DRIFT BOUND, not a per-commit checkbox. Requiring a bullet on every commit would be
 * a rule people route around within a week (and a fix commit for an unreleased feature has nothing to
 * say). The rule is: you may batch, you may not forget. Somebody has to open the file before the
 * batch gets big.
 *
 * The threshold is a budget, not a measurement: twelve user-facing commits is about a normal week's
 * worth of work here, so a release that batches its notes stays green and a changelog nobody has
 * opened in a month goes red. Raising it is a decision about how much drift is acceptable, which is
 * why it is one named constant and not an argument.
 *
 * Skips rather than fails when git cannot answer — a shallow clone or a tarball has no history to
 * measure, and a guard that reddens a build for reasons unrelated to the diff is a guard people
 * disable.
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/**
 * The two places a release note can live, and both satisfy freshness.
 *
 * `CHANGELOG.md` is the assembled document. `.changes/` is where an entry is WRITTEN — one file per
 * entry, spliced in at release time by `pnpm changelog:assemble`. That split exists because the
 * single file was the largest merge-conflict source in the repo, and this guard has to follow it:
 * measured against `CHANGELOG.md` alone, the new mechanism working perfectly — every PR adding its
 * entry file, nobody touching the assembled document between releases — reads as a changelog nobody
 * has opened in a month, and the guard reddens on exactly the behaviour it is meant to reward.
 */
const NOTES = ['CHANGELOG.md', '.changes'];

/**
 * Source of the packages we publish. Everything else — apps, bench harnesses, docs, CI — is either a
 * fixture or already its own document, and none of it belongs in release notes.
 *
 * Note the trailing `/*`: a git pathspec with a wildcard is matched against the WHOLE path, so
 * `packages/<pkg>/src` matches no file at all and quietly reports zero drift forever. That is the exact
 * failure this file exists to prevent, one level down.
 */
const SHIPPED_SOURCE = 'packages/*/src/*';

/** Conventional-commit types whose commits have nothing a user would read in release notes. */
const NOT_USER_FACING = /^(chore|test|ci|build|refactor|docs|style)(\(|!|:)/;

/** A week's worth of user-facing work. Above this, nobody has opened the changelog in too long. */
const MAX_UNDOCUMENTED_COMMITS = 12;

function git(...args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd: REPO,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/** Subjects of the user-facing commits landed since the changelog was last touched. */
function undocumented(): string[] | null {
  const last = git('log', '-1', '--format=%H', '--', ...NOTES);
  if (null === last || 0 === last.length) return null;
  const subjects = git('log', '--no-merges', '--format=%s', `${last}..HEAD`, '--', SHIPPED_SOURCE);
  if (null === subjects) return null;
  return subjects
    .split('\n')
    .filter((s) => s.length > 0)
    .filter((s) => !NOT_USER_FACING.test(s));
}

describe('the changelog is not far behind the code', () => {
  it('git history is readable, or this guard says so instead of passing quietly', ({ skip }) => {
    if (null === git('rev-parse', '--git-dir')) skip();
    expect(git('log', '-1', '--format=%H', '--', ...NOTES)).toMatch(/^[0-9a-f]{7,40}$/);
  });

  it(`at most ${String(MAX_UNDOCUMENTED_COMMITS)} user-facing commits since the changelog was last touched`, ({
    skip,
  }) => {
    const behind = undocumented();
    if (null === behind) skip();
    expect(
      behind?.length ?? 0,
      `${String(behind?.length ?? 0)} user-facing commits have landed in ${SHIPPED_SOURCE} since ` +
        `anyone touched ${NOTES.join(' or ')}. Add an entry file under .changes/ — batching is ` +
        `fine, forgetting is what this catches:\n${(behind ?? []).slice(0, 20).join('\n')}`,
    ).toBeLessThanOrEqual(MAX_UNDOCUMENTED_COMMITS);
  });
});
