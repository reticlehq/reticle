import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../../machine/repo-root.js';

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
    // `shell: true` on Windows, where pnpm is `pnpm.CMD` and a bare `execFileSync('pnpm', …)`
    // cannot execute it: the call dies with `spawnSync pnpm ENOENT`, which reads as "this guard
    // crashed" rather than "this runner spells the binary differently". Same trap as every other
    // package-manager call this repo makes from Node.
    execFileSync('pnpm', ['-r', 'list', '--depth', '-1', '--json'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      shell: 'win32' === process.platform,
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
 * Empty, and the emptiness is the point: every publishable package now carries the licence it
 * declares. `@reticlehq/engine` was the one entry, held open on the belief that giving it a file
 * would settle a licensing question by committing one. Four facts closed it rather than a
 * preference:
 *
 *   - The plan decides it, in three places and as a commercial requirement rather than a
 *     courtesy: running on the OSS engine must require NO licence, because adapter authorship
 *     that costs money means no adapters get written.
 *   - The manifest already declared `Apache-2.0`, so the file agrees with the claim rather than
 *     making a new one. Declaring a licence and shipping no text is the defect.
 *   - `git log -- engine/src` has exactly ONE author, the copyright holder. The contributor-
 *     consent question I had recorded against this entry was about five non-owner contributors
 *     who turn out to have no commits in these files at all.
 *   - The server it was carved out of is FSL-1.1-**ALv2**, which converts to Apache-2.0 by its
 *     own terms. Granting it now is the same licence earlier, never a narrower one.
 *
 * If a package ever appears in this list, something has gone wrong with how packages are created
 * here -- and an entry is a reminder to resolve, not a state to live in.
 */
const NO_LICENCE_TEXT_YET: Record<string, string> = {};

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
