import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../../machine/repo-root.js';

/**
 * The map at the top of CLAUDE.md points at directories that are there.
 *
 * That block is the first thing anybody reads to find out where anything lives, and it is the
 * first thing an agent reads before touching this repository. It named seven directories that
 * do not exist: `packages/react`, `packages/vite-plugin`, `packages/babel-plugin`,
 * `packages/next`, `packages/electron`, `packages/tauri` and `eslint-plugin`, all of which
 * moved under `adapters/` and none of which was updated here. It also had no line at all for
 * `openreality`, `engine` or `conformance`.
 *
 * A wrong map is worse than no map, and this one has a measurable cost already recorded: a
 * repository-wide grep once missed fifty-eight tracked files because the searcher was looking
 * where the map said rather than where the code was.
 *
 * Only the first column is checked. What a package is FOR is prose and cannot be verified;
 * whether the path exists is a fact, and it is the half that rots when directories move.
 */

const CLAUDE_MD = 'CLAUDE.md';

/** The fenced block holding the layout table, which is the first one in the file. */
function layoutBlock(): string {
  const text = readFileSync(join(REPO_ROOT, CLAUDE_MD), 'utf8');
  const open = text.indexOf('```');
  const close = text.indexOf('```', open + 3);
  return -1 === open || -1 === close ? '' : text.slice(open + 3, close);
}

/** The leading path on each line, for lines that start with one. */
function mappedPaths(): string[] {
  return layoutBlock()
    .split('\n')
    .map((line) => /^([A-Za-z][\w./-]*)\s{2,}/.exec(line)?.[1] ?? '')
    .filter((path) => '' !== path)
    .map((path) => path.replace(/\/$/, ''))
    .sort();
}

describe('the map at the top of CLAUDE.md', () => {
  it('finds paths to check, so a pass is not a pass over nothing', () => {
    // A changed fence, a reformatted table or a stricter regex would silently empty this.
    expect(mappedPaths().length).toBeGreaterThan(15);
    expect(mappedPaths()).toContain('server');
  });

  it('names only directories that exist', () => {
    const absent = mappedPaths().filter((path) => !existsSync(join(REPO_ROOT, path)));
    expect(
      absent,
      `${CLAUDE_MD} points at these and they are not there. This block is the first thing ` +
        'anybody reads to find out where code lives, and a wrong map sends every reader and ' +
        'every agent to the wrong place.',
    ).toEqual([]);
  });

  it('has a line for every workspace package', () => {
    // The other half: a package nobody mapped is a package nobody finds. Read from the
    // manifests rather than listed here, so adding one is enough to be asked for.
    const mapped = new Set(mappedPaths());
    const missing: string[] = [];
    for (const manifest of trackedManifests()) {
      const dir = manifest.replace('/package.json', '');
      if (dir.startsWith('apps/')) continue;
      if (!mapped.has(dir)) missing.push(dir);
    }
    expect(
      missing.sort(),
      `${CLAUDE_MD} has no line for these packages. A package nobody mapped is a package ` +
        'nobody finds.',
    ).toEqual([]);
  });
});

function trackedManifests(): string[] {
  return execFileSync('git', ['ls-files', '*/package.json'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .filter((path: string) => '' !== path);
}
