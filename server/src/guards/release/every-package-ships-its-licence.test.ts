import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../../repo-root.js';

/**
 * A package that declares a licence must ship its text.
 *
 * `package.json` naming a licence is a claim. The file beside it is what a user, a lawyer or a
 * corporate scanner actually reads, and npm includes a LICENSE automatically only when one is
 * there to include. Measured across every publishable package by running `npm pack --dry-run`
 * and reading the file list: ten carry one and `@reticlehq/engine` carries nothing.
 *
 * Nothing checked this. The other tests with "license" in the name are about the enterprise
 * licence-KEY feature, which is a different thing entirely.
 */

interface Manifest {
  readonly name?: string;
  readonly private?: boolean;
  readonly license?: string;
}

/**
 * Packages that go to a registry, asked of pnpm rather than derived.
 *
 * The first version of this walked every tracked `package.json`, which found
 * `electron-vue-pinia-renderer`: a nested manifest inside a fixture's renderer directory,
 * marked `private: false`, and not a workspace member at all. A real thing to know and not a
 * publishing risk, because nothing publishes it.
 *
 * `pnpm -r list` is the publish surface itself, so this cannot drift from what a release
 * actually pushes. A hand-kept list would have been correct the day it was written.
 */
function publishable(): { dir: string; manifest: Manifest }[] {
  const listed = JSON.parse(
    execFileSync('pnpm', ['-r', 'list', '--depth', '-1', '--json'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    }),
  ) as { name?: string; path?: string; private?: boolean }[];
  return listed
    .filter((p) => undefined !== p.name && undefined !== p.path && true !== p.private)
    .map((p) => ({
      dir: p.path ?? '',
      manifest: JSON.parse(readFileSync(join(p.path ?? '', 'package.json'), 'utf8')) as Manifest,
    }));
}

/**
 * Known to ship no licence text, with the decision it is waiting on.
 *
 * NOT an accepted state. `@reticlehq/engine` declares `Apache-2.0` and is 9,100 lines carved
 * out of `@reticlehq/server`, which is FSL-1.1. Writing an Apache-2.0 file into it would settle
 * a licensing question by committing a file, and that is not a thing to decide because a test
 * is red. So it is named here, and the name is the reminder.
 *
 * Delete the entry when the licence is chosen and its text is added. If a SECOND package ever
 * appears in this list, something has gone wrong with how packages are created here.
 */
const NO_LICENCE_TEXT_YET: Record<string, string> = {
  '@reticlehq/engine':
    'declares Apache-2.0 and ships no licence file. It was carved out of the FSL-1.1 server, so ' +
    'which licence it should carry is an open question and not one a guard should answer by ' +
    'writing a file. Blocks publishing this package correctly.',
};

describe('every published package carries the licence it claims', () => {
  it('finds the publishable packages, so a pass is not a pass over nothing', () => {
    const found = publishable();
    expect(found.length).toBeGreaterThan(8);
    expect(found.map((p) => p.manifest.name)).toContain('@reticlehq/core');
  });

  it('declares a licence in every manifest', () => {
    const undeclared = publishable()
      .filter((p) => undefined === p.manifest.license)
      .map((p) => p.manifest.name);
    expect(undeclared).toEqual([]);
  });

  it('ships the text beside it, or names the decision it is waiting on', () => {
    const missing = publishable()
      .filter((p) => !existsSync(join(p.dir, 'LICENSE')) && !existsSync(join(p.dir, 'LICENSE.md')))
      .map((p) => p.manifest.name ?? '')
      .filter((name) => NO_LICENCE_TEXT_YET[name] === undefined);
    expect(
      missing.sort(),
      'A package declares a licence and ships no text for it. npm includes a LICENSE only when ' +
        'one exists, so this publishes a claim with nothing behind it.',
    ).toEqual([]);
  });

  it('has no stale entry in the waiting list', () => {
    // The other direction: a package that HAS gained its licence text must leave the list, or
    // the list stops reading as what is still outstanding.
    const resolved = Object.keys(NO_LICENCE_TEXT_YET).filter((name) => {
      const found = publishable().find((p) => p.manifest.name === name);
      return (
        undefined !== found &&
        (existsSync(join(found.dir, 'LICENSE')) || existsSync(join(found.dir, 'LICENSE.md')))
      );
    });
    expect(resolved).toEqual([]);
  });
});
