import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './repo-root.js';

/**
 * The plugin and the CLI must look for `.reticle.json` exactly as far up as each other.
 *
 * They are separate programs that have to reach the same answer about which project this is. The
 * plugin walks up from the Vite config; the CLI walks up from the working directory. If one gives up
 * a level before the other, a dev server one level deeper than the daemon reads a different config,
 * announces a different project, and the pairing fails with nothing looking wrong.
 *
 * Six is deep enough for an app in `frontend/` or `apps/web/`, a worktree beside its main checkout,
 * and a package inside a monorepo. It is shallow enough that a dev server started somewhere unrelated
 * cannot silently adopt a distant ancestor's config and speak for another app.
 *
 * The number is small and looks arbitrary, which is exactly why one of the two would eventually be
 * "tidied" on its own. This is a source scan rather than a shared constant on purpose: the two live
 * in different packages, and `@reticlehq/vite-plugin` is a build-time package that may not import the
 * server. A shared constant would mean a shared dependency, which is a heavier answer than the
 * problem deserves.
 */

const WALKERS = [
  'server/src/command/cli/ports/resolve/cli-port.ts',
  'adapters/build/vite/src/project-id.ts',
];

/** The `.reticle.json` search depth a file declares. */
function declaredDepth(file: string): number | undefined {
  const text = readFileSync(join(REPO_ROOT, file), 'utf8');
  const match = /MAX_CONFIG_SEARCH_DEPTH\s*=\s*(\d+)/.exec(text);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

describe('both walkers look the same distance for .reticle.json', () => {
  it('each one declares a depth at all', () => {
    // Without this, a rename would leave both undefined and the check below would pass on nothing.
    for (const file of WALKERS) expect(declaredDepth(file), file).toBeGreaterThan(0);
  });

  it('they agree', () => {
    const [server, plugin] = WALKERS.map(declaredDepth);
    expect(
      plugin,
      'The Vite plugin and the CLI disagree about how far up to look for .reticle.json. They have to ' +
        'reach the same answer about which project this is, so a dev server deeper than the daemon ' +
        'would read a different config and announce a different project, and the pairing would fail ' +
        'with nothing looking wrong. Change both, or neither.',
    ).toBe(server);
  });
});
