import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './machine/repo-root.js';

/**
 * Every directory an `area/*` label points at must still exist.
 *
 * `.github/labeler.yml` is the map from a changed path to the part of the product it belongs to,
 * and it is the only machine-readable statement of what each `area/*` label MEANS. A glob whose
 * directory stops existing still parses and still runs; it simply stops matching, so the label
 * silently stops being applied and triage loses a signal without anything going red.
 *
 * This is what 3.1.0 did. The restructure moved every package out of `packages/` -- `packages/core`
 * to `core`, `packages/browser` to `adapters/realm/browser`, `packages/test` to `spec-runner` (not
 * `test/`, which exists separately and is something else) -- and the label DESCRIPTIONS on GitHub
 * still say "Affects packages/browser" today. All twelve of them name a directory that
 * `git ls-tree -r main | grep '^packages/'` returns nothing for (#981).
 *
 * The descriptions live on GitHub and only a maintainer can edit them. The globs live here, they
 * are already correct, and nothing was watching them -- so the same restructure could silently
 * break the routing again. Same shape and same reasoning as `ci-routing-paths.test.ts`, which
 * watches `ci.yml`'s filters for exactly this; the labeler was simply not on anyone's list.
 *
 * Deliberately narrow, for the reason that test gives: this catches a STALE entry, not a missing
 * one. Whether the map is COMPLETE is not a question a test can answer.
 */
const LABELER = join(REPO_ROOT, '.github', 'labeler.yml');

/**
 * TRACKED paths, not what happens to be on this disk.
 *
 * `existsSync` is the wrong question here and answers it wrongly: `packages/browser/` still holds
 * a `dist/` and a `node_modules/` on any machine that built before the 3.1.0 restructure, so a
 * glob pointing into the deleted tree passes a filesystem check while matching nothing in CI. Git
 * is the only authority on what a changed-files filter can ever match -- and it is the check the
 * issue itself used: `git ls-tree -r --name-only main | grep -c '^packages/'` returning 0.
 */
const TRACKED = new Set(
  execFileSync('git', ['ls-files'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .trim()
    .split('\n'),
);

/** Single-quoted glob literals, which is how every pattern in this file is written. */
const GLOB = /'([^']+)'/g;

/**
 * What this glob claims exists, or `undefined` when it claims nothing checkable.
 *
 * Three shapes appear in this file and only two are claims about the tree:
 *
 * - `'core/**'` roots at a directory -- the tree must track something under it.
 * - `'docs/fixtures.md'` names one file -- the tree must track exactly it.
 * - `'**\/*.md'`, `'turbo.json'` and `'.github/**'` are not claims about a location: the first two
 *   match anywhere or at the root, and a dotfile directory is infrastructure that exists by
 *   definition wherever this runs. Checking those would be wrong rather than merely unhelpful.
 */
function claimOf(glob: string): { kind: 'dir' | 'file'; path: string } | undefined {
  if (glob.startsWith('.') || glob.startsWith('*')) return undefined;
  if (!glob.includes('*')) return glob.includes('/') ? { kind: 'file', path: glob } : undefined;
  const base = glob.split('*')[0]?.replace(/\/$/, '');
  return base === undefined || !base.includes('/') ? undefined : { kind: 'dir', path: base };
}

/** Is this claim still true of the repository? */
function holds(claim: { kind: 'dir' | 'file'; path: string }): boolean {
  if ('file' === claim.kind) return TRACKED.has(claim.path);
  const prefix = `${claim.path}/`;
  for (const file of TRACKED) if (file.startsWith(prefix)) return true;
  return false;
}

describe('area labels point at directories that exist', () => {
  const globs = [...readFileSync(LABELER, 'utf8').matchAll(GLOB)].map((m) => m[1] ?? '');

  it('finds the globs, so a parse change cannot make this vacuous', () => {
    // A regex that stopped matching would pass every assertion below by having nothing to check.
    expect(globs.length).toBeGreaterThan(20);
    expect(globs).toContain('core/**');
    expect(globs).toContain('adapters/realm/browser/**');
  });

  it('every glob that names a location still finds it', () => {
    const stale = globs
      .map((glob) => ({ glob, claim: claimOf(glob) }))
      .filter((entry) => entry.claim !== undefined && !holds(entry.claim))
      .map((entry) => entry.glob);

    expect(
      stale,
      'a labeler glob names a directory that no longer exists. It still parses and still runs, ' +
        'so the label it applies simply stops being applied and triage loses the signal with ' +
        'nothing going red. Update .github/labeler.yml, and check the label DESCRIPTION on ' +
        'GitHub too -- that is a separate copy only a maintainer can edit (#981).',
    ).toEqual([]);
  });

  it('no glob still points into the pre-3.1.0 packages/ tree', () => {
    // The specific rot #981 reports, named so a reintroduction says what it is rather than only
    // that a path is missing.
    expect(globs.filter((glob) => glob.startsWith('packages/'))).toEqual([]);
  });
});
