import { describe, expect, it } from 'vitest';
import { directories, mutualPairs, nameCollisions } from '../../../../scripts/directory-reach.mjs';
import { join } from 'node:path';
import { REPO_ROOT } from '../../machine/repo-root.js';

/**
 * The coupling record, for the packages that are not `server`.
 *
 * `directory-reach.test.ts` measures `server` and nothing else. That was fine while every
 * grouping happened there, and it stopped being fine the moment the directories still over ten
 * flat files were mostly somewhere else. A move inside `engine` or `core` cannot raise
 * `MUTUAL_PAIRS_TODAY`, because that number is computed over `server/src`, so reporting "the
 * count did not rise" after such a move is true and says nothing — the same shape the sibling
 * file warns about for test files, where two extractions were signed off with a guarantee
 * rather than a measurement.
 *
 * So each package gets its own recorded numbers, and the same equality discipline: a record,
 * never a ceiling. Up means a grouping made coupling worse. Down means something got untangled
 * and the gain belongs in the same commit that earned it.
 *
 * `directories` is recorded too, and by equality, which is deliberately inconvenient. Adding a
 * subdirectory to one of these packages is exactly the moment somebody should have to write a
 * number down and look at what it did. It also catches the failure this whole file exists to
 * prevent: a scan that silently stops resolving reports an empty graph, and every assertion
 * over an empty graph passes.
 */
interface Recorded {
  readonly directories: number;
  readonly mutual: number;
  /** Why the numbers are what they are, for whoever finds this red. */
  readonly note: string;
}

const PACKAGES: Readonly<Record<string, Recorded>> = {
  core: {
    directories: 8,
    mutual: 2,
    note: 'the contract. Was four mutual pairs; moving the two constant tables into wire/constants/ freed identity <-> wire and artifacts <-> wire, because those tables were all either directory wanted from wire.',
  },
  engine: {
    directories: 5,
    mutual: 0,
    note: 'carved out of server deliberately, and it shows: four directories and nothing mutual between them.',
  },
  init: {
    directories: 6,
    mutual: 3,
    note: 'the scaffolder. detect, patch and plan each know about the others.',
  },
  'adapters/realm/dom': {
    directories: 21,
    mutual: 1,
    note: 'the SDK. Twenty-one directories and one mutual pair (dom <-> registry), which is the best ratio here.',
  },
  'spec-runner': {
    directories: 1,
    mutual: 0,
    note: 'was FLAT, and the recorded zero did its job: the first grouping here turned directories into 1, this went red, and the baseline below was measured rather than inherited. outcome/ holds how a spec reports what happened; nothing is mutual with it because it imports nothing.',
  },
  'adapters/build/vite': {
    directories: 0,
    mutual: 0,
    note: 'FLAT, same as spec-runner above, and the same reason for recording it.',
  },
};

describe('what every other package knows about itself', () => {
  it('at least one package has directories, so these checks are not all over nothing', () => {
    // If the scanner broke, every package would report zero and every assertion below would
    // pass. Two packages are legitimately flat; all of them being flat is a broken scan.
    const total = Object.keys(PACKAGES).reduce(
      (sum, name) => sum + directories(join(REPO_ROOT, name)).length,
      0,
    );
    expect(total).toBeGreaterThan(20);
  });

  for (const [name, recorded] of Object.entries(PACKAGES)) {
    describe(name, () => {
      it(`has ${String(recorded.directories)} directories`, () => {
        expect(
          directories(join(REPO_ROOT, name)).length,
          `${name}: ${recorded.note}\nAdding or removing a directory here means recording the ` +
            'new number in this file, in the commit that changed it.',
        ).toBe(recorded.directories);
      });

      it(`has ${String(recorded.mutual)} pairs that need each other`, () => {
        const pairs = mutualPairs(join(REPO_ROOT, name));
        expect(
          pairs.length,
          `${name}: ${recorded.note}\nnow ${String(pairs.length)}:\n` +
            pairs.map((pair) => `  ${pair}`).join('\n'),
        ).toBe(recorded.mutual);
      });

      it('has no two directories sharing a basename', () => {
        // The reach graph keys on the basename, so two directories with one name are a single
        // node: their reaches merge and a mutual pair between them cannot be reported at all.
        expect(nameCollisions(join(REPO_ROOT, name))).toEqual([]);
      });
    });
  }
});
