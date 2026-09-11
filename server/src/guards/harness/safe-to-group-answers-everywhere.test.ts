import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { REPO_ROOT } from '../../machine/repo-root.js';

/**
 * The advice tool must be able to answer about every directory somebody would ask it about.
 *
 * `safe-to-group` crashed on every package ROOT -- `core/src`, `init/src`, `server/src`,
 * `spec-runner/src` -- because it found the package by `indexOf('/src/')`, which needs both
 * slashes and never matches a path that ENDS at src. `-1 + 4` sliced three characters off the
 * front and it died on `scandir 'cor'`.
 *
 * The crash is not the interesting part. **A sweep over those four read as "no groups here"**,
 * because a crash prints no SAFE and no UNSAFE, and a caller looking for a verdict finds
 * nothing either way. I recorded the result as "the rule is exhausted" and it was a stack
 * trace. That is the third time in this release a tool's silence has been read as an answer,
 * after an empty group printing SAFE and an orphan scan over zero files looking like a clean
 * package, and the second time in this same tool.
 *
 * So rather than pin the one path that broke, this asks the tool about EVERY directory in the
 * repository that holds source, with a real file name from that directory, and requires a
 * verdict. Exit 0 or exit 1 are both fine -- SAFE and UNSAFE are both answers. A crash is not.
 *
 * It is a smoke test over real inputs on purpose. The previous fix to that same line was also
 * a path assumption ("stopped the day one was not"), so the thing to check is not a cleverer
 * regex but that the tool survives the actual shape of this repository.
 */

const TOOL = join(REPO_ROOT, 'scripts', 'safe-to-group.mjs');

/** Every directory holding a non-test source file, with one real name from it. */
function askableDirectories(): { readonly dir: string; readonly name: string }[] {
  const tracked = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(
      (f) =>
        f.endsWith('.ts') &&
        !f.includes('.test.') &&
        f.includes('/src/') &&
        !/^(apps|plan|bench)\//.test(f),
    );
  const first = new Map<string, string>();
  for (const f of tracked) {
    const dir = dirname(f);
    if (!first.has(dir)) first.set(dir, basename(f, '.ts'));
  }
  return [...first].map(([dir, name]) => ({ dir, name }));
}

describe('the advice tool answers about every directory in this repository', () => {
  it('finds the directories, so a pass cannot be a pass over none', () => {
    const all = askableDirectories();
    expect(all.length).toBeGreaterThan(50);
    // The shape that broke. If no package root is in the list this proves nothing about it.
    expect(all.some((d) => d.dir.endsWith('/src'))).toBe(true);
  });

  it('gives a verdict rather than a stack trace, everywhere', () => {
    const silent: string[] = [];
    for (const { dir, name } of askableDirectories()) {
      let said = '';
      try {
        said = execFileSync('node', [TOOL, dir, name], { cwd: REPO_ROOT, encoding: 'utf8' });
      } catch (thrown) {
        // Exit 1 is UNSAFE, which is an answer. Anything without a verdict line is not.
        said = (thrown as { stdout?: string }).stdout ?? '';
      }
      if (!/\b(SAFE|UNSAFE)\b/.test(said)) silent.push(`${dir} (asked about ${name})`);
    }
    expect(
      silent.sort(),
      'safe-to-group answered neither SAFE nor UNSAFE for these. A crash prints no verdict, ' +
        'so a sweep reads it as "no groups here" and the directory looks finished when the ' +
        'tool never looked at it.',
    ).toEqual([]);
    // A hundred-odd node processes, one per directory, is slow on purpose: the tool is being asked
    // the way a person asks it. It measured 4.2s alone and 7.3s beside the rest of the guard suite,
    // over a 5s default, so the timeout is set well clear of both. The invariant is the verdict,
    // never the duration, and a timeout tuned to the machine is how a green gate goes red under
    // load and nowhere else.
  }, 120_000);
});
