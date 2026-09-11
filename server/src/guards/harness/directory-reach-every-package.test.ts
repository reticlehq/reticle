import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { directories, mutualPairs, nameCollisions } from '../../../../scripts/directory-reach.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../../machine/repo-root.js';

/**
 * The coupling record, for the packages that have no record of their own.
 *
 * Five packages carry their own `directory-reach.test.ts`: server, core, engine, init and the
 * DOM adapter. I did not know that when I wrote the first version of this file, because I had
 * looked at the one the task named and not for its siblings, and so four of the six entries
 * here duplicated a guard that already existed and said more. Two records of one number is
 * worse than one: they drift, and the one you did not update is the one somebody reads.
 *
 * What was actually missing is the packages with NO record at all, which is what this is now.
 * The first test below finds them from the filesystem rather than trusting this list, so a
 * package that loses its own guard, or a new package that never had one, lands here instead of
 * going unwatched.
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
  'adapters/build/babel-plugin': {
    directories: 0,
    mutual: 0,
    note: 'FLAT. Plain CJS tooling, outside every TypeScript gate, and small enough that a directory would be ceremony.',
  },
  'adapters/build/vite': {
    directories: 1,
    mutual: 0,
    note: 'was FLAT, and the recorded zero did its job a second time: the first grouping here went red and this baseline was measured. token/ holds the pairing token and where machine state lives.',
  },
  'adapters/framework/react': {
    directories: 0,
    mutual: 0,
    note: 'FLAT. The React adapter is optional enrichment and stays small on purpose.',
  },
  'adapters/lint/eslint': {
    directories: 0,
    mutual: 0,
    note: 'FLAT. Two rules and their shared constants.',
  },
  openreality: {
    directories: 3,
    mutual: 0,
    note: 'the protocol. Three directories, nothing mutual, and until this entry existed it had no coupling record at all — which for the package the whole release is named after was the gap worth finding.',
  },
  'spec-runner': {
    directories: 2,
    mutual: 0,
    note: 'was FLAT, and the recorded zero did its job: the first grouping here turned directories into 1, the guard went red, and this baseline was measured rather than inherited. outcome/ holds how a spec reports what happened; context/ holds the four things test-context assembles into `t`.',
  },
};

describe('what every other package knows about itself', () => {
  it('covers exactly the packages that have no directory-reach test of their own', () => {
    // Found from the filesystem, never from the list above. A package that loses its own guard,
    // or one that never had a guard at all, has to appear here or this goes red.
    const manifests = execFileSync('git', ['ls-files', '*/package.json'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
      .filter((path) => '' !== path && !path.startsWith('apps/'));
    const owned = new Set(
      execFileSync('git', ['ls-files', '*/directory-reach.test.ts'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      })
        .trim()
        .split('\n')
        .filter((path) => '' !== path)
        .map((path) => path.replace(/\/src\/directory-reach\.test\.ts$/, '')),
    );
    const unguarded: string[] = [];
    for (const path of manifests) {
      const pkg = path.replace('/package.json', '');
      const manifest = JSON.parse(readFileSync(join(REPO_ROOT, path), 'utf8')) as {
        private?: boolean;
      };
      if (true === manifest.private) continue;
      if (owned.has(pkg)) continue;
      if (!existsSync(join(REPO_ROOT, pkg, 'src'))) continue;
      unguarded.push(pkg);
    }
    expect(
      unguarded.sort(),
      'these published packages have a src/ directory, no directory-reach test of their own, ' +
        'and no entry here. Either give them one or record them below.',
    ).toEqual(Object.keys(PACKAGES).sort());
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
