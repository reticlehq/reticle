/**
 * A project that DECLARES its package manager is believed (#1068).
 *
 * Reported from the field: `init` in an already-instrumented npm-workspaces project "launched a
 * pnpm dependency migration, moved the existing node_modules to .ignored, and broke next dev".
 * Moving somebody's installed tree aside is not something a scaffolder may do to a working
 * checkout, and `pnpm install` does exactly that when it finds a tree another manager built.
 *
 * The issue prescribed detecting the manager from the lockfile. That already exists and works - a
 * fixture with `package-lock.json` and a `workspaces` field resolves to npm on this build, at the
 * workspace root and inside a package. What is NOT read is `packageManager`, the corepack field,
 * which is the strongest statement a project can make: corepack will refuse to run a different
 * manager on its behalf. A repo that says `"packageManager": "npm@10"` must never be handed a pnpm
 * command, whatever lockfile happens to be above it on disk.
 */
import { describe, expect, it } from 'vitest';
import { detectPackageManager, PackageManager } from './detect.js';

const noMarkers = new Set<string>();

describe('the declared package manager', () => {
  it('is believed over an inherited lockfile of another manager', () => {
    expect(
      detectPackageManager(new Set(['pnpm-lock.yaml']), noMarkers, {
        packageManager: 'npm@10.8.2',
      }),
    ).toBe(PackageManager.NPM);
  });

  it('is believed over an installed tree another manager built', () => {
    expect(
      detectPackageManager(new Set(), new Set(['.package-lock.json']), {
        packageManager: 'pnpm@9.1.0',
      }),
    ).toBe(PackageManager.PNPM);
  });

  it('reads every manager corepack can name', () => {
    const cases: [string, PackageManager][] = [
      ['npm@10.8.2', PackageManager.NPM],
      ['pnpm@9.1.0', PackageManager.PNPM],
      ['yarn@4.3.1', PackageManager.YARN],
      ['bun@1.1.20', PackageManager.BUN],
    ];
    for (const [field, expected] of cases) {
      expect(detectPackageManager(new Set(), noMarkers, { packageManager: field })).toBe(expected);
    }
  });

  /*
   * A field nobody can read must not silently become npm — that is how a pnpm repo gets an `npm i`.
   * Anything unrecognised falls through to the evidence, which is what decided before the field
   * existed.
   */
  it('falls back to the evidence when the field says nothing usable', () => {
    for (const bad of [undefined, '', 'corepack', 42, null, 'deno@2']) {
      expect(
        detectPackageManager(new Set(['pnpm-lock.yaml']), noMarkers, { packageManager: bad }),
      ).toBe(PackageManager.PNPM);
    }
  });

  it('is not confused by a package.json that is not an object at all', () => {
    expect(detectPackageManager(new Set(['yarn.lock']), noMarkers, null)).toBe(PackageManager.YARN);
    expect(detectPackageManager(new Set(['yarn.lock']), noMarkers, 'nonsense')).toBe(
      PackageManager.YARN,
    );
  });
});
