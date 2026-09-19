import { createRequire } from 'node:module';

interface PackageJson {
  version: string;
}

// NOTE: a RUNTIME path, not an import — `tsc` does not check it and a file move will not rewrite
// it. One level up because this file sits at the package src root: from `src/` and from `dist/`
// alike, `../package.json` is the package manifest.
const _pkg: PackageJson = createRequire(import.meta.url)('../package.json') as PackageJson;

/**
 * The release THIS SCAFFOLDER belongs to, read from its own package.json at startup.
 *
 * Read here rather than injected because it is a MODULE constant in the CDN snippet builders
 * (`snippets.ts`), which pin `@reticlehq/browser@<this>` into a page with no build step and cannot
 * be built without a version in hand.
 *
 * It is NOT the same fact as "which Reticle is running", and this docblock used to claim it was:
 * "`@reticlehq/server` depends on this one by exact version, so what a user resolves here is by
 * construction the version of the server that invoked it". That is true of a tarball we publish and
 * an assumption about the tree npm assembles on somebody's machine — and #990 is what the
 * assumption cost, a 3.1.0 daemon pinning the SDK install at 2.14.0 with every step green.
 * `version-lockstep.test.ts` does not close that gap either: it compares two files in this
 * repository, which is a statement about a build.
 *
 * So the SDK install asks `InitHost.releaseVersion()` — the daemon, which knows — and this constant
 * is what a host with no daemon behind it falls back to. See `releaseToPin` in `run.ts`.
 */
export const RETICLE_VERSION: string = _pkg.version;

/**
 * The published npm package that carries the `reticle` bin — the thing this scaffolder tells users
 * and agents to run. NOT this package's own name: `@reticlehq/init` has no bin, and a self-update
 * or an `npx` line pointing at it installs a library nobody can execute. Pinned as a constant and
 * checked against `@reticlehq/server`'s manifest by `version-lockstep.test.ts`.
 */
export const RETICLE_NPM_PACKAGE = '@reticlehq/server';
