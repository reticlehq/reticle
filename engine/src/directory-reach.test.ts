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
 * The rules package, held to the rule the other two are held to.
 *
 * `@reticlehq/engine` is nine thousand lines that were carved out of the server precisely because
 * the boundary had been made clean: thirteen reaches back into the server were answered one at a
 * time before a single file moved. It arrived with **zero** mutual pairs and with nothing
 * watching them, which is the combination this guard exists for.
 *
 * **Zero is the cheapest moment there will ever be to start.** The server's guard was written at
 * thirty-two pairs, and every one of those is now a negotiation: the count comes down only when
 * somebody finds a subtractive extraction, and three of the first four candidates tried there had
 * to be moved, measured and reverted. Nothing here is tangled yet, so nothing here has to be
 * untangled — the only work is refusing the first tangle, which costs one revert instead of a
 * refactor of a file thirteen directories depend on.
 *
 * The guard's own cache key is declared on the DEFAULT `test:guards` task in `turbo.json`
 * (`$TURBO_ROOT$/scripts/**`), not per package. Every reach guard imports
 * `scripts/directory-reach.mjs`, so without that the graph implementation could change under a
 * cached pass -- the guard that would have noticed is the one that would not have run. Putting it
 * on the default is what stops the third guard inheriting the hole; the browser's guard had it
 * for as long as it has existed, because only the server had an override.
 *
 * The four directories are named after the questions they answer — `disagreement`, `evidence`,
 * `question`, `window` — and a mutual pair between any two of them would mean two questions that
 * cannot be asked apart. That is worth being told about on the commit that does it rather than
 * the release that trips over it.
 */

const ENGINE = join(
  execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: import.meta.dirname,
    encoding: 'utf8',
  }).trim(),
  'engine',
);

/**
 * Pairs where each directory reaches for the other -- the shape that makes one unmovable.
 *
 * **Zero, and it should stay zero.** Unlike the other two packages, this number is not a state
 * found and pinned; it is the state the package was designed into. Raising it is not "the count
 * went up", it is the first time two of these four questions could no longer be asked apart.
 */
const MUTUAL_PAIRS_TODAY = 0;

describe('the rules know only what they are allowed to know', () => {
  it('finds directories to check, so a passing run cannot mean it read nothing', () => {
    // The negative control, and it matters more here than elsewhere: every other assertion in
    // this file passes trivially against an empty graph, so a guard that silently read nothing
    // would report a perfect score forever.
    expect(reaches(ENGINE).size).toBeGreaterThan(2);
  });

  it('has 5 directories, and each one was a decision', () => {
    // carved out of server deliberately, and nothing here is mutual. Four of these five are wildcard export subpaths, so their FILENAMES are published API and a rename is a breaking change — see public-subpaths-are-pinned.test.ts.
    //
    // Recorded by EQUALITY, not as a floor. The check above only proves the scan read
    // something; it stays green when a directory appears, and appearing unnoticed is how a
    // grouping gets made without anybody looking at what it did to the shape of the package.
    // Adding or removing one here means writing the new number down in the same commit.
    expect(directories(ENGINE).length).toBe(5);
  });

  it('has no two directories sharing a basename', () => {
    // The graph identifies a directory by its basename, so a collision merges two nodes: reaches
    // are credited to the wrong one and a mutual pair between them cannot be reported. It has
    // happened in the server package, and every reach assertion went on passing.
    expect(
      nameCollisions(ENGINE),
      'These are one node to the reach graph. Rename one, or put the files in the directory that ' +
        'already has the name.',
    ).toEqual([]);
  });

  it('still has no pair of directories that need each other', () => {
    const pairs = mutualPairs(ENGINE);
    expect(
      pairs.length,
      `Two directories that each need the other cannot be read, moved or tested apart. This ` +
        `package had ${String(MUTUAL_PAIRS_TODAY)} and now has ${String(pairs.length)}:\n  ` +
        pairs.join('\n  ') +
        '\n\nRevert the change rather than raising the number. This package is the one place in ' +
        'the repository where the count is still nothing, and it is far cheaper to refuse the ' +
        'first tangle than to unpick it later. Ask `node scripts/safe-to-group.mjs <dir> ' +
        '<name...>` before moving files.',
      // EQUAL, not "at most", for the same reason as the other two: slack gets spent. Here it
      // also means the file says something true and checkable -- "these four questions can be
      // asked apart" -- rather than merely "it is not much worse than it was".
    ).toBe(MUTUAL_PAIRS_TODAY);
  });
});
