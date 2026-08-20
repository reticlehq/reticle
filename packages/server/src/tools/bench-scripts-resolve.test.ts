/**
 * Every benchmark script's local imports must still resolve.
 *
 * Nothing in `bench/` is run by CI — 67 scripts, three of them reachable from a package.json script,
 * zero from a workflow. So when a module they import is renamed or deleted, nothing goes red and the
 * script simply stops being runnable, silently, until somebody tries to reproduce a number with it.
 * That is not hypothetical for this repo: the whole harness fleet has been silently broken before,
 * and `bench/first-drive/measure.mjs` had been importing `dist/tools/profiles.js` since the profiles
 * were retired, which is a module that no longer exists.
 *
 * This is deliberately the CHEAP check — it resolves relative imports and does not execute anything,
 * so it runs in milliseconds and can live in the fast gate rather than behind a benchmark run. It
 * cannot tell you a script still produces a correct number. It can tell you the script can still be
 * loaded at all, which is the failure that actually happens and the one nothing else here can see.
 *
 * A benchmark whose subject was deleted should be deleted with it, not repaired to import something
 * adjacent — the number it produces is about a concept that no longer exists.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = path.resolve(__dirname, '..', '..', '..', '..');

function benchScripts(): string[] {
  const listed = execFileSync('git', ['ls-files', 'bench/'], { cwd: REPO, encoding: 'utf8' });
  return listed
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.endsWith('.mjs'));
}

/** Relative specifiers only — bare specifiers are a package-resolution question, not a rot question. */
function relativeImports(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
    const spec = match[1];
    if (spec !== undefined) found.push(spec);
  }
  for (const match of source.matchAll(/import\(\s*['"](\.[^'"]+)['"]/g)) {
    const spec = match[1];
    if (spec !== undefined) found.push(spec);
  }
  return found;
}

describe('bench scripts can still be loaded', () => {
  const scripts = benchScripts();

  it('finds scripts to check (a passing test over zero files proves nothing)', () => {
    expect(scripts.length).toBeGreaterThan(20);
  });

  it.each(scripts)('%s resolves every relative import', (script) => {
    const source = readFileSync(path.join(REPO, script), 'utf8');
    const missing = relativeImports(source).filter(
      (spec) => !existsSync(path.resolve(REPO, path.dirname(script), spec)),
    );
    expect(
      missing,
      `${script} imports modules that no longer exist. If the thing it measured was removed, ` +
        `delete the benchmark too rather than repointing it at something adjacent.`,
    ).toEqual([]);
  });
});
