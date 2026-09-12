import { createRequire } from 'node:module';

interface PackageJson {
  version: string;
}

// NOTE: a RUNTIME path, not an import — `tsc` does not check it and a file move will not rewrite
// it. One level up because this file sits at the package src root: from `src/` and from `dist/`
// alike, `../package.json` is the package manifest.
const _pkg: PackageJson = createRequire(import.meta.url)('../package.json') as PackageJson;

/**
 * The release this scaffolder belongs to, read from its own package.json at startup.
 *
 * Read here rather than injected because it is a MODULE constant in three generators
 * (`snippets.ts`, `agent-rules.ts`, `mcp.ts`) — the CDN snippet pins `@reticlehq/browser@<this>`
 * and cannot be built without it. Every published `@reticlehq/*` package shares one version, and
 * `@reticlehq/server` depends on this one by exact version, so what a user resolves here is by
 * construction the version of the server that invoked it. `version-lockstep.test.ts` in the server
 * fails the fast gate if the two manifests ever disagree.
 */
export const RETICLE_VERSION: string = _pkg.version;

/**
 * The published npm package that carries the `reticle` bin — the thing this scaffolder tells users
 * and agents to run. NOT this package's own name: `@reticlehq/init` has no bin, and a self-update
 * or an `npx` line pointing at it installs a library nobody can execute. Pinned as a constant and
 * checked against `@reticlehq/server`'s manifest by `version-lockstep.test.ts`.
 */
export const RETICLE_NPM_PACKAGE = '@reticlehq/server';
