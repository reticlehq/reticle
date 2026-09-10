import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { mutualPairs, nameCollisions, reaches } from '../../../../scripts/directory-reach.mjs';

/**
 * The browser SDK's directories, held to the same rule as the server's.
 *
 * The server has had this guard for a while and it has earned its place several times over --
 * it rejected three of the first four directory groupings attempted there, each of which would
 * have traded a shorter listing for a worse dependency graph.
 *
 * This package had nothing. It is the second-largest source tree in the repository and its
 * biggest directory, `presenter/`, has twenty-eight files, so "organise the big directories" was
 * about to be attempted here on judgement alone. Judgement has a measured record in this exercise
 * and it is three wrong out of four.
 *
 * The two mutual pairs below are the state as found, not a target. Neither is being fixed here;
 * pinning the number is what stops a third appearing unnoticed while somebody tidies a directory.
 */

const BROWSER = join(
  execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: import.meta.dirname,
    encoding: 'utf8',
  }).trim(),
  'adapters/realm/dom',
);

/**
 * Pairs where each directory reaches for the other -- the shape that makes one unmovable.
 *
 * A count, not a list: the list is derivable and printed on failure, and a second hand-written
 * copy would be one more thing to keep in step.
 *
 * `dom <-> registry` and `presenter <-> review` as of writing. Both are real and both are old.
 */
const MUTUAL_PAIRS_TODAY = 2;

describe('the browser SDK knows only what it is allowed to know', () => {
  it('finds directories to check, so a passing run cannot mean it read nothing', () => {
    expect(reaches(BROWSER).size).toBeGreaterThan(5);
  });

  it('has no two directories sharing a basename', () => {
    // The graph identifies a directory by its basename, so a collision merges two nodes: reaches
    // are credited to the wrong one and a mutual pair between them cannot be reported. It has
    // happened in the server package, where every reach assertion went on passing.
    expect(
      nameCollisions(BROWSER),
      'These are one node to the reach graph. Rename one, or put the files in the directory that ' +
        'already has the name.',
    ).toEqual([]);
  });

  it('has no more pairs that need each other than it had', () => {
    const pairs = mutualPairs(BROWSER);
    expect(
      pairs.length,
      `Two directories that each need the other cannot be read, moved or tested apart. There are ` +
        `now ${String(pairs.length)}, and there were ${String(MUTUAL_PAIRS_TODAY)}:\n  ` +
        pairs.join('\n  ') +
        '\n\nIf this rose while grouping files, the grouping is wrong: revert it rather than ' +
        'raising the number. Ask `node scripts/safe-to-group.mjs <dir> <name...>` first.',
    ).toBeLessThanOrEqual(MUTUAL_PAIRS_TODAY);
  });
});
