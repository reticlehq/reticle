import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './repo-root.js';

/**
 * Every script has to be named in `scripts/README.md`.
 *
 * There are sixteen of them. `loose-scripts.test.ts` already proves none is dead, which answers "can
 * this be deleted" -- but that was never really the question. The question is "what is this for", and
 * nothing answered it, so the only way to find out was to open each file and read it.
 *
 * A folder of scripts nobody can describe is one somebody eventually proposes deleting wholesale,
 * which is how a repository loses the check that was quietly holding something together.
 */
const INDEX = join(REPO_ROOT, 'scripts', 'README.md');

/** Tracked files directly under scripts/, excluding the index itself. */
function scriptFiles(): string[] {
  return execFileSync('git', ['ls-files', 'scripts'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((path) => path.startsWith('scripts/') && 2 === path.split('/').length)
    .map((path) => path.slice('scripts/'.length))
    .filter((name) => name.length > 0 && 'README.md' !== name)
    .sort();
}

describe('every script says what it is for', () => {
  const index = readFileSync(INDEX, 'utf8');
  const scripts = scriptFiles();

  it('finds the scripts at all', () => {
    // Without this, a change to how the folder is laid out would empty the list and the check below
    // would pass by having nothing to check.
    expect(scripts.length).toBeGreaterThan(10);
  });

  it('names every one of them', () => {
    expect(
      scripts.filter((name) => !index.includes(name)),
      'These scripts are not described in scripts/README.md. Add a row in the group that matches who ' +
        'will run it: something that runs itself, a check that fails the build, or something you type ' +
        'by hand.',
    ).toEqual([]);
  });

  it('does not describe scripts that are gone', () => {
    // A row left behind after a deletion is worse than no row: it describes something that is not
    // there, and the next person goes looking for it.
    const described = [...index.matchAll(/`([\w.-]+\.(?:mjs|sh|yaml|d\.mts))`/g)].map((m) => m[1]);
    expect([...new Set(described)].filter((name) => !scripts.includes(name ?? ''))).toEqual([]);
  });
});
