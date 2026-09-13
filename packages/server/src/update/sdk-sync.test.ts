/**
 * `reticle update` updated the DAEMON and left the app's SDK where it was.
 *
 * That is the exact pairing the whole version-skew apparatus exists to warn about, produced by the
 * command whose job is to prevent it. Worse, the skew message told people to fix an outdated SDK by
 * running `reticle update` — advice that could not work, because that command never touched the
 * app's packages. One half of the product updated, the other half was told it had.
 *
 * These pin the missing half: which packages belong to Reticle, and what a pinned sync of them looks
 * like. The pin matters for the same reason `init` pins — an unpinned `add` can resolve to a stale
 * registry cache and reinstall the very skew being fixed.
 */

import { describe, expect, it } from 'vitest';
import { PackageManager } from '@reticlehq/init';
import { reticleDepsOf, sdkSyncCommand } from './sdk-sync.js';

const TARGET = '2.5.0';

describe('reticleDepsOf — what this project has of ours', () => {
  it('finds the SDK packages across dependencies and devDependencies', () => {
    const pkg = {
      dependencies: { react: '^19.0.0', '@reticlehq/react': '2.4.0' },
      devDependencies: { vite: '^7.0.0', '@reticlehq/vite-plugin': '2.4.0' },
    };
    expect(reticleDepsOf(pkg).sort()).toEqual(['@reticlehq/react', '@reticlehq/vite-plugin']);
  });

  it('returns nothing for a project that does not use Reticle', () => {
    expect(reticleDepsOf({ dependencies: { react: '^19.0.0' } })).toEqual([]);
  });

  /**
   * `reticle update` runs from wherever the human happens to be. A directory with no package.json,
   * or junk where one should be, must produce "nothing to sync" — never a crash on the path whose
   * whole point is to leave the install in a consistent state.
   */
  it('treats a missing or malformed manifest as nothing to sync', () => {
    expect(reticleDepsOf(undefined)).toEqual([]);
    expect(reticleDepsOf(null)).toEqual([]);
    expect(reticleDepsOf('not a manifest')).toEqual([]);
    expect(reticleDepsOf({ dependencies: 'nonsense' })).toEqual([]);
  });

  /**
   * The SERVER is not an app dependency — it is the CLI, updated by the other half of this command.
   * Reinstalling it into the app would put a Node MCP server into a browser bundle's dep tree, which
   * is the exact thing the retired `@reticlehq/core` umbrella did wrong.
   */
  it('never includes the server package, which is the CLI and not an app dependency', () => {
    const pkg = { devDependencies: { '@reticlehq/server': '2.4.0', '@reticlehq/react': '2.4.0' } };
    expect(reticleDepsOf(pkg)).toEqual(['@reticlehq/react']);
  });
});

describe('sdkSyncCommand — pinned, like init', () => {
  it('pins every package to the target version', () => {
    const cmd = sdkSyncCommand(PackageManager.PNPM, ['@reticlehq/react'], TARGET);
    expect(cmd?.args).toContain(`@reticlehq/react@${TARGET}`);
    expect(cmd?.command).toBe(PackageManager.PNPM);
  });

  it('is nothing to run when the project has none of ours', () => {
    expect(sdkSyncCommand(PackageManager.NPM, [], TARGET)).toBeNull();
  });
});
