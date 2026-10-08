/**
 * The project-aware SDK remedy for version skew (#618).
 *
 * `sdkFix` in version-skew.ts is the no-project fallback: it names `@reticlehq/browser` and npm,
 * because those answers are never actively wrong. When a project directory IS in hand, name the
 * packages actually in package.json and the manager the lockfile implies.
 *
 * The manager is init's own rule, `detectPackageManager` over `resolveLockfiles`, read through a
 * declared crossing (`library-path-boundary.test.ts`); a copy kept here had fallen behind it.
 */

import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { detectPackageManager, PackageManager, resolveLockfiles } from '@reticlehq/init';
import { reticleDepsOf } from '@/memory/project/reticle-deps.js';

/** What a project contributes to the remedy, when we were able to read one. */
interface SdkFixContext {
  /** `@reticlehq/*` packages declared in package.json. Empty / omitted means none yet. */
  packages?: readonly string[];
  packageManager: PackageManagerName;
}

/** init's manager names, under the name this module exports. */
export const PackageManagerName = PackageManager;
export type PackageManagerName = PackageManager;

/** Same package a Vue/Nuxt install gets — never the React kit. */
const FRAMEWORK_NEUTRAL_SDK = '@reticlehq/browser';
const PACKAGE_JSON = 'package.json';
const NODE_MODULES = 'node_modules';
/** The files init's rule reads, probed one by one because this module is handed a file reader. */
const LOCKFILE_NAMES = [
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'bun.lock',
  'package-lock.json',
] as const;
const NODE_MODULES_MARKERS = ['.modules.yaml', '.yarn-state.yml', '.package-lock.json'] as const;

const INSTALL_FLAGS: Record<PackageManagerName, readonly string[]> = {
  [PackageManagerName.PNPM]: ['add', '-D'],
  [PackageManagerName.YARN]: ['add', '-D'],
  [PackageManagerName.BUN]: ['add', '-d'],
  [PackageManagerName.NPM]: ['i', '-D'],
};

function packagesFor(ctx: Partial<SdkFixContext> | undefined): readonly string[] {
  if (ctx?.packages !== undefined && 0 !== ctx.packages.length) return ctx.packages;
  return [FRAMEWORK_NEUTRAL_SDK];
}

function installLine(pm: PackageManagerName, pkgs: readonly string[]): string {
  return `${pm} ${[...INSTALL_FLAGS[pm], ...pkgs].join(' ')}`;
}

function restartClause(): string {
  return (
    'or run `reticle update`, then restart their dev server so the page reloads with it. The ' +
    'restart is not optional: a bundler keeps serving the pre-bundled copy it already has, so an ' +
    'upgrade can look applied — matching versions in `npm ls` — while the page runs the old module.'
  );
}

/**
 * The one sentence telling the human how to bring the page's SDK in line with this daemon.
 *
 * No context → the framework-neutral sensor and npm, never the React kit. Packages from
 * package.json win when present. When the project has none of ours yet, the sensor is named
 * rather than `@reticlehq/react` — that is the Vue/Nuxt failure.
 */
export function resolveSdkFix(daemonVersion: string, ctx?: Partial<SdkFixContext>): string {
  const pm = ctx?.packageManager ?? PackageManagerName.NPM;
  const pinned = packagesFor(ctx).map((name) => `${name}@${daemonVersion}`);
  return `Tell the human to install the matching SDK (\`${installLine(pm, pinned)}\`) ${restartClause()}`;
}

/**
 * Read the context `resolveSdkFix` needs off a parsed manifest and the lockfiles/markers present.
 *
 * Undefined when there is no manifest to interpret — the caller then uses the no-project fallback.
 * Pure: no filesystem.
 */
export function sdkFixContextOf(
  pkgJson: unknown,
  lockfiles: ReadonlySet<string>,
  nodeModulesMarkers: ReadonlySet<string> = new Set(),
): SdkFixContext | undefined {
  if ('object' !== typeof pkgJson || null === pkgJson) return undefined;
  return {
    packages: reticleDepsOf(pkgJson),
    packageManager: detectPackageManager(lockfiles, nodeModulesMarkers, pkgJson),
  };
}

/** Reads a file, or undefined if it is not there / not readable. */
function readTextFile(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function parseJson(raw: string | undefined): unknown {
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function present(
  directory: string,
  names: readonly string[],
  read: (path: string) => string | undefined,
  extra = '',
): Set<string> {
  const found = new Set<string>();
  for (const name of names) {
    if (read(join(directory, extra, name)) !== undefined) found.add(name);
  }
  return found;
}

/**
 * The remedy for the project in `directory`, or the no-project fallback when it cannot be read.
 *
 * `read` is injected so the decision is testable without a filesystem; the daemon uses the default.
 */
export function sdkFixForDirectory(
  daemonVersion: string,
  directory: string,
  read: (path: string) => string | undefined = readTextFile,
): string {
  const markers = present(directory, NODE_MODULES_MARKERS, read, NODE_MODULES);
  const exists = (path: string): boolean => read(path) !== undefined;
  const ctx = sdkFixContextOf(
    parseJson(read(join(directory, PACKAGE_JSON))),
    resolveLockfiles(present(directory, LOCKFILE_NAMES, read), directory, { exists }, markers),
    markers,
  );
  return resolveSdkFix(daemonVersion, ctx);
}
