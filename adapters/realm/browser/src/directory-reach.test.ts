import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  directories,
  mutualPairs,
  nameCollisions,
  reaches,
} from '../../../../scripts/directory-reach.mjs';

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
  'adapters/realm/browser',
);

/**
 * Pairs where each directory reaches for the other -- the shape that makes one unmovable.
 *
 * A count, not a list: the list is derivable and printed on failure, and a second hand-written
 * copy would be one more thing to keep in step.
 *
 * It hinges on one file, `dom -> capabilities`, which is not a leaf -- the same answer the same
 * computation gives for every pair in every package here, so the leaf rule cannot reach it.
 *
 * `dom <-> registry`, and that is all. It was two: extracting `presenter/chrome` broke
 * `presenter <-> review`, and nothing noticed until this assertion was changed from "at most" to
 * "exactly" -- which is the argument for the change. An unrecorded improvement is one somebody
 * else pays for twice.
 */
const MUTUAL_PAIRS_TODAY = 1;

describe('the browser SDK knows only what it is allowed to know', () => {
  it('finds directories to check, so a passing run cannot mean it read nothing', () => {
    expect(reaches(BROWSER).size).toBeGreaterThan(5);
  });

  it('has 23 directories, and each one was a decision', () => {
    // the SDK. Twenty-one directories and one mutual pair, dom <-> registry, which is the best ratio in the repository.
    //
    // Recorded by EQUALITY, not as a floor. The check above only proves the scan read
    // something; it stays green when a directory appears, and appearing unnoticed is how a
    // grouping gets made without anybody looking at what it did to the shape of the package.
    // Adding or removing one here means writing the new number down in the same commit.
    //
    // 21 -> 22 for `presenter/tour`, the first-run carousel. Its own directory rather than more
    // files in `presenter/`, because it is the one part of the panel that is fetched separately:
    // the slides, their prose and their CSS sit behind a dynamic import so a page that never shows
    // a tour never downloads one, and a boundary a bundler honours is easier to keep when it is
    // also a boundary on disk.
    //
    // 22 -> 23 for `presenter/carousel`, the chat panel's top carousel and the two cards it shows
    // (the harness offer and the founder invitation). The offer card moved in with it: it is a slide
    // now, and leaving it in `presenter/` made the two directories need each other.
    expect(directories(BROWSER).length).toBe(23);
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
        '\n\nIf this ROSE, the grouping is wrong: revert it rather than ' +
        'raising the number. Ask `node scripts/safe-to-group.mjs <dir> <name...>` first.',
      // EQUAL, not "at most". A `<=` here is slack, and slack gets spent: this number dropped from
      // 32 to 30 when one grouping untangled two pairs, and nothing would have gone red if the next
      // change had quietly put them back. An improvement that is not recorded is an improvement
      // somebody else pays for twice.
      //
      // So both directions fail. Up means a grouping made coupling worse -- revert it rather than
      // raising the number. Down means something got untangled: lower the constant in the same
      // commit, and the gain is locked in.
    ).toBe(MUTUAL_PAIRS_TODAY);
  });
});
