import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  directories,
  mutualPairs,
  nameCollisions,
  reaches,
} from '../../scripts/directory-reach.mjs';

/**
 * The contract package's directories, held to the rule the other three are held to.
 *
 * Core is the bottom of the dependency graph — everything imports it and it imports nothing but
 * `zod` and the protocol — so a tangle here is the one kind that cannot be worked around by a
 * consumer. It was also the last sizeable package with no guard at all.
 *
 * The four pairs below are the state as found, not a target, and one of them was measured twice
 * before being written down. `wire` is in three of the four, and all three rest on a single file
 * each: `artifacts` and `identity` reach `wire` only for `constants`, and `verdict` reaches it
 * only for `channel`. That looked like an easy subtractive extraction and it is not one — the
 * predictor answers UNSAFE, because the extracted node would simply become mutual with
 * `artifacts` and `verdict` instead. Four pairs would become three by relabelling the tangle,
 * which is not the same as untangling it.
 */

const CORE = join(
  execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: import.meta.dirname,
    encoding: 'utf8',
  }).trim(),
  'core',
);

/**
 * Pairs where each directory reaches for the other -- the shape that makes one unmovable.
 *
 * A count, not a list: the list is derivable and printed on failure, and a hand-written copy
 * would be one more thing to keep in step.
 *
 * The remaining pair hinges on exactly ONE file, and the leaf-extraction rule -- move only what
 * imports no sibling -- can no longer reach it. The next reduction is a SPLIT, which is a different
 * and much more expensive kind of change.
 *
 * Deleting a convenience barrel does NOT lower the number: a `export *` that re-exports another
 * directory's constants hides WHERE they came from rather than creating the dependency, and the
 * files that name those constants still name them. Lower this only in the same commit that earns
 * it, which is what the equality below is for.
 */
const MUTUAL_PAIRS_TODAY = 1;

describe('the contract knows only what it is allowed to know', () => {
  it('finds directories to check, so a passing run cannot mean it read nothing', () => {
    expect(reaches(CORE).size).toBeGreaterThan(4);
  });

  it('has 9 directories, and each one was a decision', () => {
    // the contract. Eight directories; the two constant tables moving into wire/constants/ made the eighth and took core from four mutual pairs to two.
    //
    // The ninth is `hooks/`: what Reticle says happened, for anyone building on top of it. It is a
    // contract like the wire types — the moment somebody writes `event.kind === 'bug_found'` the
    // spelling is theirs as much as ours — so it belongs in the package that holds contracts rather
    // than in the daemon that emits them. It reaches for nothing and nothing in core reaches it,
    // which is why the mutual-pair count below did not move.
    //
    // Recorded by EQUALITY, not as a floor. The check above only proves the scan read
    // something; it stays green when a directory appears, and appearing unnoticed is how a
    // grouping gets made without anybody looking at what it did to the shape of the package.
    // Adding or removing one here means writing the new number down in the same commit.
    //
    // 9 -> 10 for `test-support`, holding the `at()` replacement for `Array.prototype.at`
    // (ES2022, removed from this package's ES2017 `lib` — see legacy-syntax-guard.test.ts in
    // adapters/realm/browser, which enforces the same target here).
    expect(directories(CORE).length).toBe(10);
  });

  it('has no two directories sharing a basename', () => {
    // The graph identifies a directory by its basename, so a collision merges two nodes: reaches
    // are credited to the wrong one and a mutual pair between them cannot be reported. It has
    // happened in the server package, and every reach assertion went on passing.
    expect(
      nameCollisions(CORE),
      'These are one node to the reach graph. Rename one, or put the files in the directory that ' +
        'already has the name.',
    ).toEqual([]);
  });

  it('has no more pairs that need each other than it had', () => {
    const pairs = mutualPairs(CORE);
    expect(
      pairs.length,
      `Two directories that each need the other cannot be read, moved or tested apart. There are ` +
        `now ${String(pairs.length)}, and there were ${String(MUTUAL_PAIRS_TODAY)}:\n  ` +
        pairs.join('\n  ') +
        '\n\nIf this ROSE, revert rather than raising the number -- this package is what every ' +
        'other one imports. Ask `node scripts/safe-to-group.mjs <dir> <name...>` first, and read ' +
        'its reach lists rather than only its verdict: a move can be SAFE and still be wrong.',
      // EQUAL, not "at most". Slack gets spent, and a `<=` would have let the one real reduction
      // this repository has managed (24 -> 23 in the server) go unrecorded, so the next change
      // could have put it back with nothing going red.
    ).toBe(MUTUAL_PAIRS_TODAY);
  });
});
