import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './machine/repo-root.js';

/**
 * The server may SHIP the browser SDK. It may never IMPORT it.
 *
 * `check-boundaries.mjs` forbids a node-side package depending on a browser-side one, and that rule
 * is right about the thing it is protecting: `@reticlehq/browser` touches `document` and `window`,
 * and evaluating it in the daemon would throw on the first line that did.
 *
 * One edge is allowed against it, and this test is the condition of that exception rather than a
 * guess about the future. `reticle tutorial --run` serves a demo page carrying the real SDK, so the
 * files must be on disk beside the shipped server — a packaging relationship, where the bytes are
 * read and written to a socket and nothing Node-side ever evaluates them. Open the manifest edge to
 * allow that and you have also, silently, made `import { reticle } from '@reticlehq/browser'`
 * resolve in every file in this package. It would typecheck. It would pass lint. It would crash at
 * runtime, in the daemon, on a machine that is not ours.
 *
 * So the manifest edge is allowed and the import edge is not, and the two halves are asserted in
 * different places on purpose: the one that can be checked cheaply from a manifest is, and the one
 * that needs the source is here.
 */

const FORBIDDEN = '@reticlehq/browser';

/** Tracked, shipped TypeScript in this package — the files that become the daemon. */
function serverSources(): string[] {
  return execFileSync('git', ['ls-files', 'server/src/*.ts', 'server/src/**/*.ts'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .filter((path) => '' !== path && !/\.(test|spec)\.ts$/.test(path));
}

describe('the browser SDK ships with the server but is never loaded by it', () => {
  it('finds source files at all, so a pass is not a pass over nothing', () => {
    // This guard is a search for something that should be absent, and a search that silently stops
    // finding files reports absence perfectly.
    expect(serverSources().length).toBeGreaterThan(200);
  });

  it('never imports from the browser package', () => {
    const offenders = serverSources().filter((path) => {
      const source = readFileSync(join(REPO_ROOT, path), 'utf8');
      return (
        source.includes(`from '${FORBIDDEN}'`) ||
        source.includes(`from '${FORBIDDEN}/`) ||
        source.includes(`import('${FORBIDDEN}`) ||
        source.includes(`require('${FORBIDDEN}`)
      );
    });
    expect(
      offenders,
      `these files import ${FORBIDDEN}, which runs in a page and not in the daemon. The server ` +
        'depends on that package so it can SERVE its files as bytes to the demo page; evaluating ' +
        'it here reaches for `document` in a process that has none. Read the file instead, or take ' +
        'what you need from @reticlehq/core, which both sides share.',
    ).toEqual([]);
  });
});
