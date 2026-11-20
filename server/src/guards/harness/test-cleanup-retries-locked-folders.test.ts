/**
 * A test cleanup that removes a temp folder retries when Windows still holds the folder.
 *
 * Incident (#2158): Windows CI failed in cleanup, not in a test. `source-edit-freshness.integration.test.ts`
 * failed on `main` with `ENOTEMPTY`, and `win32-escape.test.ts` failed a pull request with `EBUSY`.
 * Every assertion had passed. On Windows, a folder can stay locked for a short time after the last
 * handle closes. A recursive, forced `rmSync` then throws, and a green change reads red. Node
 * retries these errors when the call passes `maxRetries`.
 *
 * Each package has one helper, `removeTempDirSync`, that passes it. This guard finds a recursive
 * `rmSync` in a test file that does not pass `maxRetries`, so a new cleanup does not bring the failure
 * back.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '@/machine/repo-root.js';

const TEST_FILE = /\.test(?:-helpers)?\.(?:ts|tsx|mts|mjs)$/;
const RM_SYNC = /\brmSync\(/g;
const RECURSIVE = /\brecursive:\s*true\b/;
const RETRIES = /\bmaxRetries:/;

/** The text between the parentheses of the call that opens at `start`. */
function callArguments(source: string, start: number): string {
  let depth = 1;
  let index = start;
  while (depth > 0 && index < source.length) {
    const char = source[index];
    if ('(' === char) {
      depth += 1;
    } else if (')' === char) {
      depth -= 1;
    }
    index += 1;
  }
  return source.slice(start, index - 1);
}

interface RecursiveRemove {
  where: string;
  retries: boolean;
}

function recursiveRemoves(): RecursiveRemove[] {
  const tracked = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((path) => TEST_FILE.test(path));
  const found: RecursiveRemove[] = [];
  for (const path of tracked) {
    const source = readFileSync(join(REPO_ROOT, path), 'utf8');
    for (const match of source.matchAll(RM_SYNC)) {
      const args = callArguments(source, match.index + match[0].length);
      if (!RECURSIVE.test(args)) {
        continue;
      }
      const line = source.slice(0, match.index).split('\n').length;
      found.push({ where: `${path}:${line}`, retries: RETRIES.test(args) });
    }
  }
  return found;
}

describe('test cleanups retry a locked temp folder', () => {
  const removes = recursiveRemoves();

  it('finds recursive removes at all, so a pass is not a pass over nothing', () => {
    expect(removes.filter((remove) => remove.retries).length).toBeGreaterThan(0);
  });

  it('passes maxRetries in every recursive rmSync of a test file (use removeTempDirSync)', () => {
    expect(removes.filter((remove) => !remove.retries).map((remove) => remove.where)).toEqual([]);
  });
});
