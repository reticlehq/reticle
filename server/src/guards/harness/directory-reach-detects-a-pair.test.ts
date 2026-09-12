import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mutualPairs, reaches, nameCollisions } from '../../../../scripts/directory-reach.mjs';

/**
 * The graph five guards are frozen against, driven over a fixture instead of over this repo.
 *
 * `directory-reach.test.ts` exists five times — server, browser, core, engine, init — and each
 * freezes two numbers computed by `scripts/directory-reach.mjs`. `safe-to-group.mjs` is a sixth
 * caller, and the server guard's own header says three copies of one graph computation "is
 * three chances for the prediction to disagree with the test it predicts". They share one
 * implementation for that reason, and that implementation had no test of its own.
 *
 * The five guards cannot supply this. Each asserts a frozen number over the real tree, so all
 * five stay green if the graph silently starts finding FEWER edges — the recorded count only
 * refuses to grow. A resolver that quietly stopped following imports would read as the
 * untangling going well.
 *
 * Driven over a fixture with a known answer, both directions:
 *
 *   a -> b and b -> a   must be one mutual pair
 *   a -> b only         must be none
 *
 * The second is the half that matters. A detector that answers "mutual" to everything satisfies
 * the first on its own, and would have frozen every package at a number nobody could lower.
 *
 * This was prompted by planting a real back-edge in this repository and watching the server
 * guard go from 22 to 23. It did, and said so clearly. That was a one-off check that left
 * nothing behind; this is the part that stays.
 */

let fixture: string | undefined;

afterEach(() => {
  if (fixture !== undefined) rmSync(fixture, { recursive: true, force: true });
  fixture = undefined;
});

/** A package whose `src` holds two directories, wired as asked. */
function planted(backEdge: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'reach-'));
  fixture = dir;
  mkdirSync(join(dir, 'src', 'alpha'), { recursive: true });
  mkdirSync(join(dir, 'src', 'beta'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{"name":"fixture"}');
  writeFileSync(
    join(dir, 'src', 'alpha', 'one.ts'),
    "import { two } from '../beta/two.js';\nexport const one = two;\n",
  );
  writeFileSync(
    join(dir, 'src', 'beta', 'two.ts'),
    backEdge
      ? "import type { one } from '../alpha/one.js';\nexport const two: typeof one | undefined = undefined;\n"
      : 'export const two = 1;\n',
  );
  // A real repository, because `sourceFiles` asks git what it tracks rather than reading the
  // directory. That is the right design -- it is how the scan cannot drift from what is
  // committed, and it is why a repo-root `grep -r` once missed 58 tracked files here -- so the
  // fixture honours it instead of stubbing it out.
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  };
  git('init', '-q');
  git('add', '-A');
  return dir;
}

describe('the shared directory graph finds what the five guards are frozen against', () => {
  it('sees both directories at all, so an empty answer cannot mean it read nothing', () => {
    const map = reaches(planted(true));
    expect([...map.keys()].sort()).toEqual(['alpha', 'beta']);
  });

  it('calls two directories that import each other a mutual pair', () => {
    expect(mutualPairs(planted(true))).toHaveLength(1);
  });

  it('does NOT call a one-way import a mutual pair', () => {
    // The control. Without it, a detector that answers "mutual" to every edge passes the test
    // above and freezes every package at a number no amount of untangling could lower.
    expect(mutualPairs(planted(false))).toEqual([]);
  });

  it('still reports the one-way edge, so "not mutual" is not "not seen"', () => {
    const map = reaches(planted(false));
    expect([...(map.get('alpha') ?? [])]).toEqual(['beta']);
    expect([...(map.get('beta') ?? [])]).toEqual([]);
  });

  it('finds no name collision between two differently-named directories', () => {
    expect(nameCollisions(planted(true))).toEqual([]);
  });
});
