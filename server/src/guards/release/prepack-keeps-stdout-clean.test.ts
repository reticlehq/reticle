import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { REPO_ROOT } from '../../machine/repo-root.js';

/**
 * Nothing a `prepack` script runs may print on stdout.
 *
 * `npm pack --json` writes its report to stdout. Anything a prepack script prints there is
 * prepended to that report, and the JSON stops parsing — which is how a tarball size check or
 * a supply-chain audit is scripted, and `package-quality.yml` already parses exactly that.
 *
 * `core/scripts/gen-schema.mjs` and `scripts/prepare-dist.mjs` both learned this and both wrote
 * the reason down beside the fix. `openreality` was added afterwards, did not inherit either
 * comment, and shipped a `console.log` in the same position — on the package whose whole
 * purpose is being audited by other people. Two files carrying the explanation were not enough
 * to stop the third making the mistake, which is the argument for a check rather than a third
 * comment.
 *
 * Only the scripts a prepack actually invokes are read, found from the manifests rather than
 * listed here, so a new package or a new build step is covered without anybody remembering to
 * add it.
 */

interface Invoked {
  readonly pkg: string;
  readonly script: string;
}

/** Local `node path/to/script.mjs` invocations inside every published package's prepack. */
function prepackScripts(): Invoked[] {
  const manifests = execFileSync('git', ['ls-files', '*/package.json'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .filter((path) => '' !== path && !path.startsWith('apps/'));
  const found: Invoked[] = [];
  for (const manifest of manifests) {
    const parsed = JSON.parse(readFileSync(join(REPO_ROOT, manifest), 'utf8')) as {
      private?: boolean;
      scripts?: Record<string, string>;
    };
    if (true === parsed.private) continue;
    const prepack = parsed.scripts?.['prepack'];
    if (undefined === prepack) continue;
    const pkgDir = dirname(manifest);
    for (const match of prepack.matchAll(/node\s+([\w./-]+\.mjs)/g)) {
      const rel = match[1];
      if (undefined === rel) continue;
      const abs = resolve(REPO_ROOT, pkgDir, rel);
      if (existsSync(abs)) found.push({ pkg: pkgDir, script: abs.slice(REPO_ROOT.length + 1) });
    }
  }
  return found;
}

/** A `console.log` call, not the words in a comment warning about one. */
const STDOUT_CALL = /(^|[^\w.])console\s*\.\s*log\s*\(/;

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('what a prepack script prints', () => {
  it('finds prepack scripts at all, so a pass is not a pass over nothing', () => {
    expect(prepackScripts().length).toBeGreaterThan(3);
  });

  it('strips comments without stripping code', () => {
    // The whole check turns on this: two files in this repository carry the word console.log
    // inside a comment explaining why they do not call it, and a stripper that failed open
    // would report them and a stripper that failed shut would report nobody.
    expect(STDOUT_CALL.test(stripComments('// console.log(1)\nconst a = 1;'))).toBe(false);
    expect(STDOUT_CALL.test(stripComments('/* console.log(1) */\nconst a = 1;'))).toBe(false);
    expect(STDOUT_CALL.test(stripComments('console.log(1);'))).toBe(true);
  });

  it('writes progress to stderr, never stdout', () => {
    const noisy = prepackScripts()
      .filter(({ script }) =>
        STDOUT_CALL.test(stripComments(readFileSync(join(REPO_ROOT, script), 'utf8'))),
      )
      .map(({ pkg, script }) => `${script} (prepack of ${pkg})`)
      .sort();
    expect(
      [...new Set(noisy)],
      'these run inside a prepack and print on stdout. `npm pack --json` prepends that to its ' +
        'report and the JSON stops parsing, taking any size check or supply-chain audit with ' +
        'it. Use process.stderr.write: progress is diagnostics, the tarball is the product.',
    ).toEqual([]);
  });
});
