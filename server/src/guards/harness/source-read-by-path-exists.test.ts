import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { REPO_ROOT } from '../../machine/repo-root.js';

/**
 * A file this repository reads BY PATH must still be where the string says.
 *
 * Several checks read source rather than importing it, because what they assert is about the
 * text: that two entry points wire the same helpers, that a rule is proved somewhere, that the
 * spec names every value. Reading is the right tool for those. The cost is that the path is a
 * STRING, so the compiler cannot see it, and a rename or a directory move leaves it pointing
 * at nothing.
 *
 * That has now happened three times in this release, each in a different disguise:
 *
 *   `lint:docs` named six test files by path in package.json, and the tools moved.
 *   Three loose scripts required `../server/dist/license/license.js`, and it moved to
 *     `dist/features/license/`.
 *   `act-verdict-parity.test.ts` read `assert-verdict.ts`, and the assert group moved.
 *
 * The first two have guards now. This is the third case: source reading source.
 *
 * **Deliberately narrow, and the narrowness is the whole design.** A sweep for every
 * path-shaped string literal finds 449 and flags 351, because almost all of them are FIXTURE
 * names -- `vite.config.ts`, `app/layout.tsx`, `nuxt.config.ts` -- describing a project a test
 * simulates rather than a file in this repository. A guard that cries wolf 351 times gets
 * switched off, which `script-paths-exist` already says in its own header about over-matching.
 *
 * So only paths anchored to a directory constant are checked: `join(REPO, ...)`,
 * `join(HERE, ...)` and their siblings. That is what "a file in this repository" looks like
 * when it is written down, and a fixture name never carries one. Forty-three sites, and they
 * all resolve.
 */

/** Anchors that mean "somewhere in this repository", and what each resolves against. */
const ANCHORS: Record<string, 'repo' | 'file'> = {
  REPO: 'repo',
  REPO_ROOT: 'repo',
  ROOT: 'repo',
  PACKAGE_ROOT: 'repo',
  HERE: 'file',
  SRC: 'file',
  'import.meta.dirname': 'file',
  __dirname: 'file',
};

const ANCHOR_ALT = Object.keys(ANCHORS)
  .map((a) => a.replace(/\./g, '\\.'))
  .join('|');
const PATH_LIT = "'([^']+\\.(?:ts|tsx|mjs|cjs|js|json|md|mdx|yaml|yml))'";

/**
 * An anchored join read at the call site, rather than through a helper.
 *
 * No example path here on purpose: a plausible-looking one in a comment is picked up by
 * guards-are-cache-invalidated as a real repo-root read, and it then demands a turbo input for
 * a file that does not exist. That guard is right to scan text and this comment was wrong to
 * put a path in it.
 */
const DIRECT = new RegExp(`join\\(\\s*(${ANCHOR_ALT})\\s*,\\s*${PATH_LIT}`, 'g');

/**
 * A one-line helper that hides the anchor, then its call sites.
 *
 * `const src = (file: string): string => readFileSync(join(import.meta.dirname, file), 'utf8')`
 * is the shape that broke when the assert group moved, and the first version of this guard did
 * not see it: the path never appears beside an anchor, only beside the helper's name. Matching
 * only the direct form meant this test cited a breakage it could not have caught, which is
 * the defect it exists to prevent, one level up.
 */
const HELPER = new RegExp(
  `const (\\w+) = \\([a-z]\\w*: string\\)[^=]*=> *readFileSync\\(join\\(\\s*(${ANCHOR_ALT})\\s*,`,
  'g',
);

function sourceFiles(): string[] {
  return (
    execFileSync(
      'git',
      ['ls-files', 'server/src', 'core/src', 'engine/src', 'init/src', 'openreality/src'],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    )
      .split('\n')
      .filter((f) => '' !== f && /\.tsx?$/.test(f))
      // Not this file. Its negative control NAMES a path that must be absent, and a scanner
      // cannot tell that from a read of a file that has gone missing. Excluding the one file
      // whose job is to assert absence is the only self-reference here, and leaving it in made
      // the guard fail on itself the moment the control was written.
      .filter((f) => !f.endsWith('source-read-by-path-exists.test.ts'))
  );
}

/** Every read of a repository file by path, however the anchor is spelled. */
function anchoredReads(): { readonly site: string; readonly target: string }[] {
  const out: { site: string; target: string }[] = [];
  for (const file of sourceFiles()) {
    const text = readFileSync(join(REPO_ROOT, file), 'utf8');
    const baseFor = (anchor: string): string =>
      'file' === ANCHORS[anchor] ? join(REPO_ROOT, dirname(file)) : REPO_ROOT;

    for (const m of text.matchAll(DIRECT)) {
      const anchor = m[1] ?? '';
      const rel = m[2] ?? '';
      out.push({ site: `${file} -> ${anchor}/${rel}`, target: join(baseFor(anchor), rel) });
    }
    for (const h of text.matchAll(HELPER)) {
      const name = h[1] ?? '';
      const anchor = h[2] ?? '';
      const calls = new RegExp(`\\b${name}\\(\\s*${PATH_LIT}\\s*\\)`, 'g');
      for (const c of text.matchAll(calls)) {
        const rel = c[1] ?? '';
        out.push({ site: `${file} -> ${name}('${rel}')`, target: join(baseFor(anchor), rel) });
      }
    }
  }
  return out;
}

describe('a path this repository reads is a path that exists', () => {
  it('finds the reads, so a pass cannot mean it looked at nothing', () => {
    // Three anchors were in use when this was written and the count was 43. A bound rather
    // than the number, because the number moves for honest reasons every week.
    expect(anchoredReads().length).toBeGreaterThan(20);
  });

  it('resolves every one of them', () => {
    const missing = anchoredReads()
      .filter((r) => !existsSync(r.target))
      .map((r) => r.site);
    expect(
      missing.sort(),
      'A check reads this file by path and the file is not there. The compiler cannot see a ' +
        'path in a string, so a rename or a directory move breaks it silently and only a run ' +
        'finds out. Repoint the string, or read the file by importing it.',
    ).toEqual([]);
  });

  it('would notice a path that stopped resolving', () => {
    // The negative control, run against a constructed site rather than by editing a real one:
    // an anchored read of a file that is not there must not resolve.
    expect(existsSync(join(REPO_ROOT, 'server/src/surface/tools/assert-verdict.ts'))).toBe(false);
    expect(existsSync(join(REPO_ROOT, 'server/src/surface/tools/assert/assert-verdict.ts'))).toBe(
      true,
    );
  });
});
