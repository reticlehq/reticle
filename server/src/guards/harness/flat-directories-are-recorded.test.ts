import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
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
 * How many source files sit loose in one directory, recorded so it cannot creep.
 *
 * A directory with forty files in it is not a design; it is what happens when nobody was
 * counting. This sweep took `agent/tools` from 160 to 32, `features/flows` from 35 to 24 and
 * `command/daemon` from 15 to 7, one verified extraction at a time — and every one of those
 * numbers can drift straight back, one file per commit, with no gate anywhere noticing.
 *
 * Nothing else here measures this. The reach guards count DIRECTORIES and the pairs between
 * them, which says how tangled the package is and nothing at all about how much is piled inside
 * any one of them. A file added flat to a big directory changes no reach, breaks no pair, and
 * is invisible to every check in the repository.
 *
 * So the over-ten directories are listed with their counts, by equality. Growing one is not
 * forbidden — it is a thing to do deliberately, in a commit that says the number went up and
 * why. Shrinking one is the work this list exists to protect, and lowering the number in the
 * same commit is what locks the gain in, exactly as the mutual-pair counts do.
 *
 * Test files are excluded, as everywhere else in this family of guards, because a directory
 * with ten sources and ten tests beside them is not the problem being described.
 */

/** The line the sweep was run against. Ten is the user's number, not a derived one. */
const FLAT_FILE_LIMIT = 10;

/**
 * Measured 2026-09-11, at the end of a sweep of twenty-seven verified extractions.
 *
 * Three entries will not come down by the rule that produced the rest, and say so here rather
 * than looking like neglect:
 *
 *   server/src/telemetry            another agent owns these files; not mine to move.
 *   engine/src/question/predicate   a wildcard export subpath. The FILENAMES are published API
 *   engine/src/evidence             and moving one is a breaking change — see
 *                                   public-subpaths-are-pinned.test.ts.
 */
const OVER_THE_LINE: Readonly<Record<string, number>> = {
  'adapters/build/vite/src': 11,
  'adapters/realm/dom/src/dom': 11,
  'adapters/realm/dom/src/observers': 23,
  'adapters/realm/dom/src/presenter': 16,
  'core/src/verdict': 11,
  'core/src/wire': 15,
  // 15 since the shared step-effect builder. Recorded rather than grouped: the note above explains
  // why this directory cannot come down by the usual rule — its FILENAMES are published API, so
  // moving one to tidy the count would be a breaking change for somebody outside this repository.
  'engine/src/evidence': 15,
  'engine/src/question/predicate': 15,
  'init/src/patch': 14,
  'server/src/agent/runs': 11,
  'server/src/agent/tools': 32,
  // Crossed the line when a planned step gained its own `expect`: the grading rule and its test
  // joined the act cluster (preflight, target, retry, capsule). Recorded rather than grouped,
  // because this directory IS the grouping -- these files were split out of act-tools.ts when it
  // hit the line cap, and splitting them again would scatter one cohesive unit across two homes.
  'server/src/agent/tools/act': 11,
  'server/src/command/cli': 17,
  'server/src/command/setup': 15,
  'server/src/connection/session': 20,
  'server/src/features/flows': 25,
  'server/src/features/journal': 11,
  'server/src/telemetry': 32,
  'spec-runner/src': 11,
};

/** Tracked, shipped, non-test TypeScript, grouped by the directory it sits in. */
function flatCounts(): Map<string, number> {
  const tracked = execFileSync('git', ['ls-files', '*.ts', '*.tsx'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .filter((path) => '' !== path);
  const counts = new Map<string, number>();
  for (const path of tracked) {
    // apps/ are local fixtures, plan/ is gitignored design notes, bench/ is the harness.
    if (/^(apps|plan|bench)\//.test(path)) continue;
    if (/\.(test|spec|bench)\.tsx?$/.test(path)) continue;
    const dir = dirname(path);
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  return counts;
}

describe('how much sits loose in one directory', () => {
  it('finds source files at all, so a pass is not a pass over nothing', () => {
    // A listing that silently stopped resolving would report no directories over the line, and
    // the whole check would read as a clean bill of health.
    const counts = flatCounts();
    expect(counts.size).toBeGreaterThan(50);
    expect([...counts.values()].reduce((sum, n) => sum + n, 0)).toBeGreaterThan(500);
  });

  it(`records every directory holding more than ${String(FLAT_FILE_LIMIT)} source files`, () => {
    const found: Record<string, number> = {};
    for (const [dir, count] of [...flatCounts()].sort()) {
      if (count > FLAT_FILE_LIMIT) found[dir] = count;
    }
    expect(
      found,
      STAGED_NOTE +
        'the flat-file counts moved. A directory that grew: add the file somewhere it belongs, or ' +
        'raise the number here on purpose. A directory that shrank, or left the list: lower or ' +
        'remove it in the same commit, so the next person does not pay for the same tidying ' +
        'twice. A directory that APPEARED: it just crossed the line, which is the moment to ' +
        'group it rather than the moment to record it.',
    ).toEqual(OVER_THE_LINE);
  });
});
