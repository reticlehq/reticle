import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { mutualPairs, nameCollisions, reaches } from '../../scripts/directory-reach.mjs';

/**
 * The scaffolder's directories, held to the rule the other four packages are held to.
 *
 * `@reticlehq/init` is the first thing a user runs and the last package here with no structural
 * guard at all. Its five biggest directories carry eleven to twenty-three files each, so
 * "organise the big directories" was going to be attempted here sooner or later, and the record
 * of doing that on judgement alone in this repository is three wrong out of the first four.
 *
 * Three pairs, and they were measured against a reduction attempt before being written down.
 * Both obvious candidates are refused by the predictor:
 *
 *   `plan/plan.ts` is the ONLY thing `diagnose` and `register` take from `plan`, so lifting it
 *   looks like two pairs for free. It reaches back out to `diagnose` and `register` itself, so
 *   the extracted node simply inherits both: frees two, creates three.
 *
 *   `register/mcp.ts` is the only thing `project` takes from `register`. It is reached from and
 *   reaches the package root, so it trades one pair for another and adds a directory.
 *
 * Neither is an improvement, so the number below is the state as found rather than a target.
 */

const INIT = join(
  execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: import.meta.dirname,
    encoding: 'utf8',
  }).trim(),
  'init',
);

/**
 * Pairs where each directory reaches for the other -- the shape that makes one unmovable.
 *
 * A count, not a list: the list is derivable and printed on failure, and a hand-written copy
 * would be one more thing to keep in step.
 */
const MUTUAL_PAIRS_TODAY = 3;

describe('the scaffolder knows only what it is allowed to know', () => {
  it('finds directories to check, so a passing run cannot mean it read nothing', () => {
    expect(reaches(INIT).size).toBeGreaterThan(3);
  });

  it('has no two directories sharing a basename', () => {
    // The graph identifies a directory by its basename, so a collision merges two nodes: reaches
    // are credited to the wrong one and a mutual pair between them cannot be reported. It has
    // happened in the server package, and every reach assertion went on passing.
    expect(
      nameCollisions(INIT),
      'These are one node to the reach graph. Rename one, or put the files in the directory that ' +
        'already has the name.',
    ).toEqual([]);
  });

  it('has no more pairs that need each other than it had', () => {
    const pairs = mutualPairs(INIT);
    expect(
      pairs.length,
      `Two directories that each need the other cannot be read, moved or tested apart. There are ` +
        `now ${String(pairs.length)}, and there were ${String(MUTUAL_PAIRS_TODAY)}:\n  ` +
        pairs.join('\n  ') +
        '\n\nIf this ROSE, revert rather than raising the number. Ask ' +
        '`node scripts/safe-to-group.mjs <dir> <name...>` first, and read its reach lists rather ' +
        'than only its verdict: both candidates here were SAFE-looking and made things worse.',
      // EQUAL, not "at most". Slack gets spent, and a `<=` would let the one reduction this
      // repository has managed go unrecorded so the next change could put it back silently.
    ).toBe(MUTUAL_PAIRS_TODAY);
  });
});
